import { createHmac, randomBytes } from 'node:crypto';
import { CHANNELS, suggestedChannel } from './bling.js';
import { AppError } from './mercado-livre.js';

export function installBlingRoutes(app,{db,bling,config,requireLogin}) {
  const secret=randomBytes(32);
  const csrf=req=>createHmac('sha256',secret).update(req.sessionId).digest('hex');
  const guard=(req,res,next)=>req.body.csrf===csrf(req)?next():next(new AppError('O formulário expirou. Atualize a página.',403));
  const callback=()=>{
    if(config.BLING_REDIRECT_URI) return config.BLING_REDIRECT_URI;
    try {const url=new URL(config.ML_REDIRECT_URI);url.pathname='/integracoes/bling/callback';url.search='';url.hash='';return url.href;} catch {return 'https://SEU-DOMINIO/integracoes/bling/callback';}
  };
  app.get('/integracoes/bling',requireLogin,(req,res)=>res.render('bling',{configured:bling.configured(),blingConnected:Boolean(db.getBlingToken(req.session.user_id)),callback:callback(),csrf:csrf(req),cache:db.getBlingCache(req.session.user_id),settings:db.getBlingSettings(req.session.user_id),channels:CHANNELS,suggestedChannel}));
  app.post('/integracoes/bling/conectar',requireLogin,guard,(req,res)=>{
    if(!bling.configured()) throw new AppError('Cadastre o aplicativo no Bling e configure BLING_CLIENT_ID, BLING_CLIENT_SECRET e BLING_REDIRECT_URI no servidor.',503);
    const state=randomBytes(32).toString('base64url');db.saveBlingState(state,req.sessionId,req.session.user_id,Date.now()+600000);
    res.redirect(303,`https://www.bling.com.br/Api/v3/oauth/authorize?${new URLSearchParams({response_type:'code',client_id:config.BLING_CLIENT_ID,state})}`);
  });
  app.get('/integracoes/bling/callback',requireLogin,async(req,res)=>{
    if(typeof req.query.state!=='string' || !db.takeBlingState(req.query.state,req.sessionId)) throw new AppError('Retorno do Bling inválido ou expirado. Inicie uma nova conexão.',400);
    if(req.query.error || typeof req.query.code!=='string' || !req.query.code) throw new AppError('A conexão com o Bling não foi autorizada.',400);
    await bling.exchange(req.session.user_id,{grant_type:'authorization_code',code:req.query.code});
    res.redirect(303,'/integracoes/bling');
  });
  app.post('/integracoes/bling/sincronizar',requireLogin,guard,async(req,res)=>{await bling.sync(req.session.user_id);res.redirect(303,'/integracoes/bling');});
  app.post('/integracoes/bling/configurar',requireLogin,guard,(req,res)=>{
    const cache=db.getBlingCache(req.session.user_id);
    if(!cache) throw new AppError('Importe os dados do Bling antes de mapear os canais.',400);
    const channels={},statuses={},commissions={};
    for(const shop of cache.shops) {
      const channel=req.body[`channel_${shop.id}`];
      if(!Object.hasOwn(CHANNELS,channel)) throw new AppError('Canal inválido.',400);
      channels[shop.id]=channel;
    }
    for(const status of cache.statuses) {
      const value=req.body[`status_${status.id}`];
      if(!['paid','cancelled','pending'].includes(value)) throw new AppError('Situação inválida.',400);
      statuses[status.id]=value;
    }
    for(const channel of Object.keys(CHANNELS).filter(c=>c!=='mercado_livre')) {
      const raw=req.body[`fee_${channel}`];
      if(raw===undefined || raw==='') continue;
      if(typeof raw!=='string' || !/^\d+(?:[.,]\d{1,2})?$/.test(raw)) throw new AppError('Comissão inválida.',400);
      const value=Number(raw.replace(',','.'));
      if(value<0 || value>100) throw new AppError('A comissão deve estar entre 0 e 100%.',400);
      commissions[channel]=value;
    }
    db.saveBlingSettings(req.session.user_id,{channels,statuses,commissions});res.redirect(303,'/mc?periodo=month');
  });
}
