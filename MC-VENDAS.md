# MC Vendas

Implementação local baseada no manual `instrucoes_mc_vendas.pdf` (20/08/2026). Mercado Livre usa a API direta. Foi preparado um conector Bling para Shopee, TikTok Shop, Amazon, Shein, Temu e Kwai Shop; ainda falta cadastrar e autorizar o aplicativo no ERP. Nenhum dado de demonstração entra no banco de produção.

## Acesso e operação

- `/promocao/mc`: entrada pelo painel, no menu Promoção.
- `/mc`: monitor sem cabeçalho de navegação.
- `/api/mc/realtime`: resposta JSON autenticada, sem comprador ou credenciais.
- `/integracoes/bling`: instruções de cadastro, conexão OAuth, importação, mapeamento de lojas/situações e comissões estimadas.
- Quatro abas: Ao vivo, Análise, Preços e Ranking.
- Períodos Hoje, Ontem, Mês atual, Mês anterior e Personalizado; calendário em America/Sao_Paulo (UTC-03 para as datas atuais).
- Filtros de conta, canal disponível, envio, pedido, produto e faixas de MC. Ranking por SKU ou MLB, cinco ordenações e classificação ABC sobre MC positiva. As lojas do Bling ficam vinculadas à sessão do vendedor que autorizou o ERP.
- Tela revisada a cada 60 segundos; pausa quando oculta, durante edição ou com simulador/cadastro aberto. A coleta é verificada ao carregar a tela e renovada após cinco minutos. Não existe um agendador independente do acesso ao painel.
- Atualizar agora força a coleta e permite buscar o intervalo personalizado (até 366 dias). Coletas simultâneas do módulo compartilham a mesma execução.
- Custo manual por SKU aplica os valores no momento da consulta, recalculando o histórico. O cadastro de custos existente é compartilhado pelo aplicativo; não representa custos independentes por conta.

## Cálculo e qualidade

Os valores monetários derivados são calculados em centavos. O rateio por item preserva o total do pedido. Receita de produtos = bruto dos itens menos desconto financiado pelo vendedor. A MC preliminar deduz tarifa, frete do vendedor, custo cadastrado e imposto sobre essa receita. O imposto é uma estimativa operacional baseada na alíquota cadastrada, sem validação fiscal individual.

`paid` e `partially_refunded` são os estados aceitos nos agregados de vendas. Canceladas e demais estados ficam em contadores separados. Vendas sem custo continuam no faturamento. Custo, imposto e MC agregados têm sua cobertura explicitada; uma MC sem dados suficientes é `null`, nunca zero. Um período sem vendas tem MC zero.

Tarifa ausente, desconto sem confirmação, frete desconhecido e devolução por conciliar impedem uma MC completa. Registros legados sem metadados também ficam pendentes até nova coleta. A tarifa vem de `sale_fee × quantity`; frete de `senders[].cost` para o vendedor correspondente. O frete do comprador vem de `receiver.cost` e, quando incluído, aumenta igualmente receita e despesa, mantendo MC em reais e alterando seu percentual.

Pacotes e fretes próprios/Flex sem custo operacional conciliado permanecem pendentes, evitando cobrar um mesmo frete inteiro em cada pedido ou presumir custo zero. Reembolsos registrados em pagamentos deixam a MC pendente até conciliar tarifa devolvida, retorno da mercadoria e demais ajustes. O módulo não usa a estimativa de reembolso da tela legada de devoluções como valor financeiro confirmado.

O comparativo de ontem usa o mesmo horário de hoje. O mês anterior é comparado pelo menor número de dias fechados disponível nos dois meses. A projeção usa tempo decorrido no mês. Comparações e projeções refletem o histórico local, que pode estar incompleto; a data da primeira venda não comprova cobertura integral.

O simulador usa custo unitário, frete médio e percentuais históricos de tarifa/imposto. Não altera anúncios. As faixas históricas comparam MC por dia **com venda**. Não há evidência de exposição do preço nos dias sem venda; por isso não são apresentadas como preço ótimo, demanda prevista ou ganho futuro garantido.

## Configurar o Bling

1. Criar um aplicativo para a empresa no Bling, com nome sugerido **Tenha em Casa — MC Vendas**.
2. Cadastrar a URL HTTPS do dashboard acrescida de `/integracoes/bling/callback`. A página de conexão mostra a URL a partir da configuração do servidor; não usar literalmente `SEU-DOMINIO`.
3. Habilitar JWT e os escopos de leitura de Pedidos de Venda, Canais de Venda e Situações/Módulos. O conector não escreve pedidos, preços ou estoque no ERP.
4. Configurar `BLING_CLIENT_ID`, `BLING_CLIENT_SECRET` e `BLING_REDIRECT_URI` no `.env` privado do servidor e reiniciar a aplicação. Os segredos não devem ser enviados pelo chat ou gravados no Git.
5. Acessar `/integracoes/bling`, autorizar e importar. Conferir lojas e situações antes de salvar. A classificação de pagamento é explícita, por ID da situação; situação desconhecida é pendente. O número de uma situação do ERP não é presumido universal.

O OAuth usa state descartável vinculado à sessão. As chamadas usam `https://api.bling.com.br/Api/v3`, cabeçalho `enable-jwt: 1`, renovação compartilhada e espaçamento de 350 ms. Erros e limites preservam o último cache concluído. A importação inicial lê 65 dias e a atualização automática ocorre a cada quatro horas **durante acesso ao dashboard**. Atualizar agora inclui o Bling se já autorizado.

Somente campos de pedidos necessários ao painel são persistidos: não são guardados contato, endereço, observações nem etiqueta. Os dados originais de comissão do ERP não são presumidos equivalentes à tarifa real do marketplace: a tela permite configurar comissão percentual estimada por canal. Falta de ajuste não equivale a zero.

Pedidos do Mercado Livre identificados no Bling são excluídos para evitar duplicação com a API direta. Se houver outras contas de ML no ERP, elas também ficam excluídas nesta versão até implementar vínculo explícito entre contas e deduplicação por pedido/pacote. Pedidos dos demais canais usam IDs com prefixo `bling:` e lojas separadas. Campos de data do ERP sem horário não entram na comparação intradia.

A coleta de pedidos do Bling não confirma integralmente reembolsos/créditos de tarifa. Por isso, embora os pedidos mapeados como pagos participem do faturamento e dos rankings de volume, sua MC fica pendente de conciliação. Ter uma comissão manual não libera sozinho uma MC completa. O custo de produtos ainda é o cadastro manual existente; não foi implementada importação automática de custo do fornecedor no Bling.

## Escopo ainda dependente de integração

| Requisito do PDF | Situação |
| --- | --- |
| Conciliação ao centavo com repasse/settlement | Pendente de amostra oficial; toda MC é apresentada como preliminar |
| Shopee, TikTok, Amazon, Shein, Temu e Kwai Shop via Bling | Conector preparado e testado com API simulada; falta cadastro/autorização real |
| Magalu e site | Não pedidos nesta etapa; podem ser classificados como Outros quando presentes no Bling |
| Múltiplas contas consolidadas | Lojas do Bling por sessão; outras contas ML ainda não incluídas |
| Comissões manuais de canais sem tarifa real | Configuráveis por canal ERP, explicitamente estimadas; ML usa tarifa do pedido |
| CT-e, fatura, cotação e tabela de frete | Não conectados; nenhuma chave ou fonte fictícia habilitada |
| Auditoria do frete contra anúncio | Falta coleta da referência histórica e conciliação dos pacotes |
| Devoluções descontadas com valor confirmado | Falta conciliar reembolsos, créditos de tarifa, estoque e frete de retorno |
| Faturamento por linha de produto | Falta cadastro de linhas e vínculo SKU-linha |
| Efeito de promoções antes/depois | Falta histórico de campanhas e exposição de preço |
| Preço ótimo e ganho potencial | Falta histórico de exposição/demanda suficiente para estimar |
| Coleta contínua sem tela aberta | Falta agendador persistente, com controle de cotas e retentativas |

## Verificação e publicação

`npm test` verifica autenticação, proteção CSRF das novas escritas, validação dos custos, HTML escapado, estados de pagamento, filtros, calendário, rateio, valores incompletos, recálculo retroativo, idempotência e preservação do cache após coleta incompleta. O banco de teste é em memória.

Os testes do Bling verificam OAuth/JWT, state de uso único, renovação concorrente, isolamento entre usuários, sanitização, mapeamento de situações, exclusão de ML duplicado e renderização dos canais nas quatro abas.

Antes da publicação da nova fórmula, confrontar uma amostra com os repasses oficiais, conforme a regra 11 do PDF. Incluir venda simples, múltiplos itens, pacote, cupom cofinanciado, tarifa fixa, frete subsidiado e devolução. Conferir centavo a centavo cada componente, não apenas MC total. Nenhuma validação com dados reais foi realizada nesta implementação local.

A revisão visual no navegador ficou pendente porque o runtime não encontrou navegador disponível nesta sessão. As quatro páginas foram renderizadas e verificadas por HTTP nos testes. As mudanças não foram publicadas no servidor.

## Fontes consultadas

- [Pedidos e descontos — Mercado Livre](https://developers.mercadolivre.com.br/pt_br/gerenciamento-de-vendas)
- [Envios — Mercado Livre](https://developers.mercadolivre.com.br/pt_br/gerenciamento-de-envios)
- [Custos e cotações — Mercado Livre](https://developers.mercadolivre.com.br/pt_br/mercadolideres-lojas-oficiais/mercado-envios-custos-e-cotacoes)
- [Aplicativos e autorização — Bling](https://developer.bling.com.br/aplicativos)
- [Referência da API — Bling](https://developer.bling.com.br/referencia), esquema OpenAPI oficial consultado em 10/09/2026.
- [Autenticação JWT — Bling](https://developer.bling.com.br/migracao-jwt)
