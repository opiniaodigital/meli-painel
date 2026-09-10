# Painel Mercado Livre

Aplicativo local em JavaScript, Express e SQLite. Requer **Node.js 24 ou superior** (usa `node:sqlite`).

## Como rodar

```powershell
cd "C:\Users\Felipe Hausen\meli-painel"
npm install
Copy-Item .env.example .env
```

Preencha `.env` com o ID e o segredo do seu aplicativo do Mercado Livre e a URL de retorno:

```dotenv
ML_APP_ID=seu_app_id
ML_CLIENT_SECRET=seu_client_secret
ML_REDIRECT_URI=https://seu-endereco-publico/callback
```

Cadastre exatamente essa URL de retorno no aplicativo do Mercado Livre, habilite leitura de pedidos e acesso offline para renovação, e configure PKCE (S256). Para desenvolvimento, use um endereço HTTPS que encaminhe para a porta local 3000 (por exemplo, um túnel) e abra o aplicativo por esse mesmo endereço antes de conectar, para manter o cookie de login. Não altere o domínio entre o início do login e o retorno.

```powershell
npm start
```

Página local: **http://localhost:3000**. Clique em **Conectar Mercado Livre** para autorizar sua conta. Sem credenciais, a página inicial funciona e exibe instruções. Para mudar a porta, acrescente `PORT=3001` ao `.env`. Reinicie após editar as variáveis. `npm run dev` reinicia ao alterar o código; `npm test` executa testes com API simulada.

## Dados e rotas

- `/`: página inicial; `/auth/mercadolivre`: início do OAuth; `/callback`: retorno da autorização.
- `/painel`: vendas e pedidos pagos em BRL criados nos últimos 30 dias corridos; top 10 por unidades, agrupando variações do mesmo anúncio.
- `/api/vendas`: mesmos indicadores em JSON, com a sessão autenticada do navegador (sem expor tokens).

O total soma `total_amount` dos pedidos pagos; o ranking soma quantidade × preço unitário. Valores brutos, sem descontar taxas ou reembolsos; não representam lucro. Pedidos cancelados, pendentes e de outras moedas são excluídos. O período exato é refinado localmente porque o filtro remoto considera horas. Todas as páginas são consultadas; falhas da API geram erro, nunca um total parcial apresentado como completo.

`dados.db` é criado automaticamente na pasta do projeto, com tokens, vendedor, validade e sessões. A sessão dura 30 dias e permanece após reiniciar. O token é renovado antes das consultas quando faltam cinco minutos para expirar, usando `expires_in` retornado (normalmente 6 horas). Cada renovação substitui os dois tokens atomicamente; consultas simultâneas compartilham a renovação. Execute uma única instância do servidor por banco. Uma resposta 401 tenta renovar uma vez; autorização revogada exige nova conexão.

Mantenha `.env` e `dados.db` privados; ambos estão no `.gitignore`. A aplicação serve apenas os arquivos de `public/` e exige sessão para os dados da conta.

Referências: [OAuth](https://developers.mercadolivre.com.br/autenticacao-e-autorizacao) e [pedidos](https://developers.mercadolivre.com.br/pt_br/gerenciamento-de-vendas).
