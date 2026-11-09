# Futevolei 2026 — inscrição de atletas

Aplicação de página única para a competição de 28 e 29 de novembro de 2026.
Next.js, React, shadcn/ui (Radix), Zustand 5, React Hook Form, Zod, Prisma 7
e PostgreSQL 18.6. Foram usadas versões estáveis: PostgreSQL 19 e Prisma 8
ainda são pré-lançamentos no momento da implementação.

## Executar localmente

Requisitos: Node.js 24, npm e Docker com Compose.

```bash
npm install
npm run setup:local
docker compose up --detach --wait
npm run db:migrate
npm run dev
```

Abra <http://localhost:3000>. Use **`npm run dev`**, não `npx run dev`.
`setup:local` cria `.env` com uma senha aleatória para o banco local, sem
sobrescrever arquivos existentes. Se `.env` já existe, revise sua configuração
em vez de executar novamente esse comando.

O PostgreSQL é exposto somente em `127.0.0.1:5433`, usa autenticação
SCRAM-SHA-256 e preserva dados em volume Docker. Para parar sem apagar
dados: `docker compose stop`.

Para usar um PostgreSQL existente, configure `DATABASE_URL` e execute
`npm run db:migrate` somente no banco destinado a esta aplicação.
Não há reset automático.

### Criar o administrador

Após aplicar as migrations, defina `SEED_ADMIN_PASSWORD` no `.env` local
(não versionado) ou no ambiente e execute:

```bash
npx prisma db seed
```

O comando usa `tsx prisma/seed.ts`, configurado em `prisma.config.ts`.
O seed conecta ao banco de `DATABASE_URL` e cria o administrador
`admin@ligainternacontornodabola.com`, armazenando somente o hash bcrypt
da senha. Execuções posteriores preservam o usuário e a senha existentes.
Não use senhas reais em arquivos versionados.

Para diagnosticar HTTP 500 em produção, consulte os logs de `/api/registrations`.
Erros conhecidos do Prisma registram o código (por exemplo, `P2021` para tabela
ausente ou `P2022` para coluna ausente), sem registrar a mensagem completa,
credenciais ou dados do formulário. Confirme que as migrações foram aplicadas
ao mesmo banco definido em `DATABASE_URL` no ambiente Production da Vercel.

As variáveis `POSTGRES_USER`, `POSTGRES_DB` e `POSTGRES_PASSWORD` do Docker
só inicializam um volume vazio. Alterá-las no `.env` não cria usuários,
bancos nem muda senhas em volumes existentes, mesmo ao recriar o container.
Nesse caso, crie o usuário/banco no PostgreSQL ou ajuste `DATABASE_URL`
para as credenciais existentes. Não apague o volume para resolver P1000.

`npx prisma migrate dev` cria um shadow database temporário e exige
`CREATEDB` no usuário PostgreSQL de desenvolvimento. Se ocorrer P3014,
um administrador deve conceder essa permissão apenas no ambiente local
ou configurar um banco shadow separado. Não conceda superusuário para isso.
Para aplicar migrations existentes, use `npm run db:migrate`
(`prisma migrate deploy`), que não precisa de shadow database.

O vínculo `Registration.pairOfPlayersId` com `PairOfPlayers.id` usa colunas
`TEXT` nos dois lados. A dupla é opcional no cadastro atual; inscrições
existentes permanecem sem vínculo após a migração.
Novos parceiros são associados por inscrição e categoria em
`PairOfPlayers.registrationId` e `categoryId`, sem modificar o vínculo legado.
`player1Id` armazena o nome informado do parceiro, não um ID de usuário.

## Configurar Pix e envio de PDF

Consulte [`.env.example`](./.env.example). Configure as variáveis no `.env`
ou no ambiente de implantação. Next.js dá prioridade ao `.env.local`,
quando presente. A chave Pix e o destinatário fornecidos pelo solicitante
estão somente na configuração local ignorada pelo Git.

| Variável | Uso |
|---|---|
| `DATABASE_URL` | URL PostgreSQL com usuário, senha codificada para URL e banco |
| `FUTEVOLEI_PRISMA_DATABASE_URL` | URL usada pelo Prisma CLI nas migrations; deve apontar para o mesmo banco de `DATABASE_URL` |
| `PIX_KEY` | Chave Pix do recebedor |
| `PIX_MERCHANT_NAME` | Nome real do recebedor, máximo de 25 caracteres após normalização |
| `PIX_MERCHANT_CITY` | Cidade real do recebedor, máximo de 15 caracteres após normalização |
| `REGISTRATION_EMAIL` | E-mail da organização, destinatário fixo do PDF |
| `SMTP_HOST`, `SMTP_PORT` | Servidor e porta SMTP |
| `SMTP_SECURE` | `true` para TLS direto, normalmente 465; `false` para STARTTLS, normalmente 587 |
| `SMTP_USER`, `SMTP_PASS` | Credenciais SMTP; para Gmail, use senha de app quando disponível |
| `SMTP_FROM` | E-mail remetente autorizado pelo provedor |
| `APP_ORIGIN` | Origem pública exata, sem barra final, usada para validar requisições |
| `TRUST_PROXY` | `true` somente quando o proxy sobrescreve `x-forwarded-for` |

Nome e cidade Pix são normalizados para maiúsculas sem acentos, mas não
truncados. Configurações ausentes ou inválidas produzem erro explícito.
Nunca coloque credenciais em variáveis `NEXT_PUBLIC_*` ou arquivos versionados.
Reinicie o servidor após alterar a configuração.

Em produção, SMTP exige TLS/STARTTLS com certificado válido. A fonte Noto Sans
usada no PDF está incluída no rastreamento de arquivos do Next.js.

Se o aviso indicar envio do PDF não confirmado, consulte os logs de
`/api/registrations` na Vercel e procure `[registration-email]`. O diagnóstico
indica a etapa: `configuration` (variáveis SMTP), `pdf` (geração do documento),
`smtp` (envio) ou `confirmation` (confirmação no banco após o envio).
Falhas de envio individuais indicam também `destinatário organization` ou
`destinatário athlete`, sem registrar o endereço de e-mail.
Somente códigos técnicos permitidos são registrados, sem mensagens completas,
credenciais ou dados do atleta. Exemplos:

- `etapa pdf; Error; código ENOENT`: arquivo necessário ao PDF ausente.
- `etapa smtp; Error; destinatário organization; código EAUTH; SMTP 535`:
  autenticação SMTP rejeitada.
- `etapa smtp; Error; destinatário athlete; código ETIMEDOUT`:
  conexão ou resposta SMTP expirou.
- `etapa configuration; ConfigurationError; configuração SMTP_PORT`:
  variável ausente ou inválida no ambiente da implantação.

Atualize a configuração indicada no ambiente Production e faça um novo deploy.
Tente novamente pela mesma inscrição; não crie outro cadastro para reenviar.
Uma falha em `confirmation` pode ocorrer depois de o SMTP aceitar o PDF;
o aviso não garante que o e-mail não tenha sido enviado.

## Fluxo e regras

- Apelido e etapas são opcionais. Os demais dados e pelo menos uma categoria
  são obrigatórios. Nascimento: data válida de 1900 até hoje.
- E-mail é convertido para minúsculas ao preencher. Telefone opcional usa
  máscara `(99) 99999-9999` e nascimento usa `dd/mm/aaaa`, com formatação ao
  digitar via `use-mask-input`. A API continua recebendo nascimento em `aaaa-mm-dd`.
- Uma categoria custa R$ 60,00. Cada adicional soma R$ 40,00:
  duas custam R$ 100,00 e todas as oito custam R$ 340,00.
- O servidor valida os dados e calcula o preço em centavos. Não aceita
  totais do cliente, categorias desconhecidas ou duplicadas.
- A seleção atualiza QR Code Pix estático e código copia e cola.
- Cada categoria marcada exibe à direita um campo opcional de nome do parceiro.
  Em celular, o campo pode quebrar para a próxima linha. Desmarcar remove o
  nome daquela categoria. Os nomes são salvos e incluídos por categoria no PDF.
- O envio registra a inscrição no PostgreSQL e gera um PDF anexado ao
  e-mail fixo da organização (`REGISTRATION_EMAIL`) e ao e-mail validado do
  atleta, em mensagens separadas, sem expor um destinatário ao outro.
- **O pagamento permanece pendente.** QR Code estático não verifica
  pagamento e o PDF não é comprovante.
- O PDF é gerado uma vez por tentativa. A aceitação SMTP é confirmada no banco
  por destinatário (`emailSentAt` para organização e `athleteEmailSentAt` para
  atleta). O resumo informa quais envios foram confirmados ou estão pendentes.
  Falhas parciais não impedem a tentativa de envio ao outro destinatário.
- Falhas SMTP preservam a inscrição e permitem retry pelo mesmo botão,
  sem duplicar o cadastro nem repetir envios já confirmados. Campos ficam
  bloqueados após iniciar o envio
  para preservar a mesma operação, inclusive em falhas de comunicação.
  Rejeições definitivas do servidor, como HTTP 400/409, liberam os campos
  para correção mantendo o protocolo. HTTP 408/429, falhas de rede e respostas
  incertas mantêm os dados da tentativa para retry seguro. Há tempo limite
  de resposta de 55 segundos, sem cancelar o cadastro já iniciado no servidor.
- Dados pessoais não são salvos no armazenamento do navegador. Somente
  o protocolo opaco é preservado em sessionStorage, inclusive ao recarregar
  a mesma aba. Preencha novamente os mesmos dados para recuperar a operação.
  Após o envio confirmado, use "Cadastrar outro atleta" para iniciar uma
  operação nova. Fechar a aba perde esse protocolo.
- `SENT` significa aceitação pelo servidor SMTP para ambos os destinatários,
  não garantia de entrega na caixa de entrada. Confira spam e regras do provedor.
- Há reserva temporária para evitar envios concorrentes. Falha do processo
  depois da aceitação SMTP e antes da atualização do banco pode causar
  reenvio. O `Message-ID` permanece estável, mas entrega exatamente uma vez
  não pode ser garantida por SMTP.
- A migration de envio ao atleta preserva confirmações antigas da organização
  e deixa a cópia do atleta pendente. Não há disparo automático para inscrições
  antigas: uma nova consulta/reenvio pelo mesmo protocolo envia apenas a cópia
  ainda não confirmada. Aplique as migrations antes de executar o código novo.

Requisições de cadastro têm limite de 16 KiB e limitação de 30 tentativas
por minuto em PostgreSQL. Sem proxy confiável, o limite é global; com
`TRUST_PROXY=true`, é por endereço encaminhado. Não confie em cabeçalhos
públicos. Há validação de origem e campo antispam invisível.

## Validar

```bash
npm test
npm run test:integration
npm run typecheck
npm run lint
npm run build
```

Os testes de integração criam um container PostgreSQL isolado, com senha e
porta aleatórias, aplicam migrations e usam SMTP local com dados fictícios.
O script define `DATABASE_URL` e `FUTEVOLEI_PRISMA_DATABASE_URL` para o mesmo
banco temporário, isolando tanto as migrations quanto as consultas de teste.
O container é removido no final; nenhum e-mail real é enviado. Os testes
validam persistência, PDF, preço, reenvio, concorrência e erros de entrada.
Os testes Pix decodificam as imagens QR geradas e conferem valores e CRC.

Produção:

```bash
npm run db:migrate
npm run build
npm start
```

Configure HTTPS, banco persistente e SMTP antes de disponibilizar inscrições.
Estabeleça com a organização política de privacidade, acesso e retenção dos
dados pessoais; esta versão não inclui painel administrativo.
