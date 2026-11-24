# Lembra Aí — lembretes de contas pelo WhatsApp

A pessoa cria uma conta, confirma o número do WhatsApp e cadastra as contas (luz, água, aluguel, cartão...).
O sistema avisa no WhatsApp dela antes de vencer, **pelo número do sistema** (o seu chip). Assim, a mensagem chega como a de outra pessoa, com notificação normal.

- **Render (free):** roda o servidor (Node + Baileys), com uma conexão "WhatsApp Web" no chip do sistema.
- **Supabase:** guarda contas, lembretes, avisos e a sessão do WhatsApp. Pode ser um projeto novo ou o mesmo do Agendador: os nomes das tabelas não batem.
- **UptimeRobot:** ping a cada 5 min pro Render não dormir.

## Como funciona

1. A pessoa cria a conta e **confirma o número**: o sistema manda um código de 4 números pelo WhatsApp, e ela digita no site.
   - Sem confirmar, não dá pra criar lembrete.
   - O código vale 10 min e aceita no máximo 5 tentativas.
   - Dá pra pedir um código por minuto, no máximo 5 por hora.
   - O mesmo número não pode estar em duas contas.
2. Ela cadastra os lembretes:
   - O que é, nome e valor (opcional).
   - Quando vence: todo mês no dia X, ou uma vez só. Dia 31 em mês mais curto vira o último dia do mês.
   - Com quanta antecedência avisar (15, 10, 7, 5, 3, 2 ou 1 dia antes, e/ou no dia) e o horário.
   - Mensagem padrão, ou uma própria com `{nome}`, `{conta}`, `{valor}`, `{vencimento}` e `{quando}`. A tela mostra uma prévia de como vai chegar.
   - Botão **✨ Sugerir com IA**: o Gemini cria 3 mensagens no tom escolhido (amigável, divertido, direto ou formal). A pessoa clica numa, e ela vai pro campo de mensagem, onde dá pra editar.
3. O sistema prepara os avisos dos próximos 45 dias e manda cada um no horário. Entre um envio e outro espera 2 a 4 segundos, pra não parecer robô. Todo aviso termina com "Já pagou? Responda *paguei*".
4. A pessoa pode **responder o aviso** no WhatsApp:
   - **paguei** (ou "pago", "já paguei", "quitei"...): marca a conta como paga e cancela os avisos que ainda iam sair daquele vencimento.
     - Se ela respondeu **em cima de um aviso**, vale aquela conta.
     - Se escreveu **"paguei a luz"**, vale a conta da luz.
     - Se tiver mais de uma em aberto, o sistema pergunta qual e ela responde com o número.
   - **desfazer**: desfaz o último "paguei" (até 24h depois), e os avisos voltam a sair.
   - **parar**: pausa todos os lembretes dela.
   - **ajuda** / **oi**: explica os comandos.
   - No site também tem **Já paguei** e **desfazer** em cada lembrete.
5. Quem manda mensagem **sem ter conta** recebe um convite com o link de cadastro. Quem criou a conta mas não digitou o código recebe um lembrete pra confirmar.
   - Cada número recebe isso **no máximo 1 vez por semana**, guardado no banco, então vale mesmo depois de o Render reiniciar. E são no máximo 30 convites por hora no total: responder estranhos demais aumenta o risco de o chip ser marcado como spam.
   - O link usa o endereço do Render automaticamente. Se usar um domínio próprio, coloque em `SITE_URL`.
   - Mensagem que o sistema não entende recebe a ajuda no máximo 1 vez a cada 6h. E nunca são mais de 20 respostas por hora pra mesma pessoa, pra não entrar em loop com outro robô.

## Planos

| | Grátis | Premium |
|---|---|---|
| Lembretes | até 3 | ilimitados |
| Avisos por lembrete | 1 | vários |
| Mensagem personalizada + IA | — | ✓ |
| Ícone e cor | — | ✓ |
| "paguei" pelo WhatsApp, histórico | ✓ | ✓ |

- **Preços:** ficam nas variáveis `PRECO_MENSAL` e `PRECO_ANUAL` (padrão R$ 9,90 e R$ 79,90). O site e o painel usam os mesmos valores.
- **Pagamento:** com o Asaas ligado (seção 8), a assinatura é automática: a pessoa paga e o Premium liga sozinho. Sem Asaas, dá pra usar um link fixo em `PREMIUM_LINK` e liberar à mão. Sem nenhum dos dois, a tela avisa que o pagamento online chega em breve.
- **Liberar o Premium:** na janela do admin (**Número do sistema → Planos das contas**), busque o e-mail e escolha "+30 dias", "+1 ano", "sem prazo" ou "Voltar pro Grátis". Renovar soma a partir do fim do período que ainda está valendo.
- **Quando o Premium acaba:** nada é apagado. Funcionam só os 3 lembretes mais antigos, com 1 aviso cada (o mais perto do vencimento) e mensagem padrão. Assinando de novo, tudo volta como era. As contas Premium aparecem com o cadeado e o botão "Liberar com Premium" nos lembretes parados.

## Página de apresentação

Quem abre o site sem estar logado vê a página de apresentação (`public/lp.html`), com como funciona, recursos, planos e dúvidas. Quem está logado vai direto pro painel. Os botões levam pra `/login` e `/login#cadastro`.

## Segurança e detalhes de uso

- **Aviso com opções (enquete):** cada aviso chega como uma enquete do WhatsApp com **✅ Já paguei** e **⏰ Me lembra mais tarde**. No "mais tarde", chega outra enquete perguntando quando: daqui 1 hora, daqui 3 horas, hoje à noite (20h) ou amanhã de manhã (9h). O "paguei" digitado continua funcionando. Os votos chegam cifrados pelo próprio WhatsApp e o servidor abre com o segredo de cada enquete (guardado cifrado na tabela `enquetes`). Pra voltar ao aviso só de texto: `AVISO_COM_ENQUETE=0` no Render.
- **Dados cifrados:** nome, e-mail e telefone (de todo mundo, admin incluído), o nome, valor e mensagem de cada lembrete, o texto dos avisos enviados e a sessão do WhatsApp do sistema ficam cifrados no banco com **AES-256-GCM**. Quem abrir o Supabase só vê `c1.xxxx`. A chave fica só no servidor (`CHAVE_DADOS`).
  - Cada valor fica amarrado à sua tabela, coluna e linha: copiar um dado cifrado de um lugar pro outro não funciona, e qualquer alteração no dado cifrado é detectada.
  - Pra achar a conta no login (e-mail) e quando a pessoa responde no WhatsApp (número), o banco guarda um **índice cego** (HMAC-SHA256 com outra chave derivada): dá pra buscar, mas não dá pra voltar ao dado.
  - Números de quem escreveu sem ter conta também viram índice: o número não fica guardado.
  - Ao subir, o servidor cifra sozinho o que ainda estiver aberto no banco (dados de antes da criptografia).
- **Senhas:** Argon2id (19 MiB de memória, 2 passadas, recomendação da OWASP). As senhas antigas (scrypt) passam pro Argon2id no próximo login da pessoa, sem ela perceber.
- **Trocar a chave:** gere uma nova (`npm run gerar-chave`), coloque a nova em `CHAVE_DADOS` e a antiga em `CHAVE_DADOS_ANTIGAS`. Ao subir, o servidor regrava tudo com a nova. Depois de ver no log que terminou, pode apagar a antiga.
- **Perdeu a chave = perdeu os dados.** Guarde uma cópia da `CHAVE_DADOS` num gerenciador de senhas. Sem ela, nem você consegue ler os dados cifrados.
- **Login:** 5 senhas erradas na mesma conta travam o login dela por 15 minutos. 20 erros vindos do mesmo IP (tentando vários e-mails) também travam por 15 minutos. Cada erro ainda demora meio segundo a mais pra responder, o que deixa o chute de senha bem lento.
- **Cadastro:** no máximo 5 contas novas por hora vindas do mesmo IP. O e-mail é conferido de dois jeitos: a tela sugere a correção de erro de digitação ("gmial.com" → "Você quis dizer gmail.com?") e o servidor recusa domínio que não recebe e-mail (consulta o DNS; se o DNS estiver fora, deixa passar).
- **Entrar com código no WhatsApp:** na tela de login, "Entrar com código no WhatsApp" manda um código de 6 números pro WhatsApp confirmado da conta (vale 10 minutos, 5 tentativas). Funciona com ou sem o 9 na frente do número.
- **Esqueci minha senha:** a pessoa digita o e-mail (ou o WhatsApp), recebe o código no WhatsApp e cria uma senha nova. Ao trocar a senha, as sessões abertas em outros aparelhos caem. A resposta é sempre a mesma, exista a conta ou não, pra ninguém descobrir quem tem cadastro. Só funciona pra quem já confirmou o WhatsApp; quem não confirmou precisa falar com o admin.
- **Limites dos códigos:** 1 código por minuto e 5 por hora por conta, 10 pedidos por hora por IP e 20 códigos errados por IP a cada 15 minutos.
- **Ícone e cor:** cada lembrete pode ter um ícone e uma cor próprios (são 23 ícones e 9 cores). Se a pessoa não escolher, vale o padrão do tipo.
- **Página 404:** qualquer endereço que não existe mostra uma página animada com o botão "Ir pro início".
- **Carregamento:** enquanto o painel carrega, aparecem caixas cinzas piscando no formato do conteúdo.

## 1. Supabase

1. Use um projeto novo, ou o mesmo do Agendador.
2. Vá em **SQL Editor → New query**, cole o `supabase.sql` e clique em **Run**.
3. Copie:
   - **Project Settings → Data API → Project URL** → `SUPABASE_URL` (só `https://xxxx.supabase.co`)
   - **Project Settings → API Keys → secret key** (`sb_secret_...`) → `SUPABASE_SERVICE_ROLE_KEY`

## 2. GitHub

Crie um repositório novo e suba a pasta:

```bash
git init
git add .
git commit -m "lembra aí"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/lembretes-whatsapp.git
git push -u origin main
```

## 3. Render

As 750h grátis por mês são **por workspace**, e um serviço ligado 24h gasta quase tudo. Então este projeto precisa de um **workspace só dele**: não pode ficar no do Radar nem no do Agendador. Outra opção é o plano pago (Starter), que não tem esse limite.

1. **New → Web Service** → escolha o repositório.
2. Build: `npm install` · Start: `npm start` · Instance: **Free**.
3. **Environment:**

| Variável | Valor |
|---|---|
| `SUPABASE_URL` | URL do projeto |
| `SUPABASE_SERVICE_ROLE_KEY` | secret key |
| `CHAVE_DADOS` | chave da criptografia: rode `npm run gerar-chave` no seu computador e cole o resultado (guarde uma cópia!) |
| `RESPONSAVEL_NOME` | seu nome completo ou a razão social (aparece nos Termos e na Privacidade) |
| `CONTATO_EMAIL` | e-mail de contato pra dúvidas, reembolso e pedidos de privacidade |
| `RESPONSAVEL_DOCUMENTO` | opcional, ex.: `CNPJ 00.000.000/0001-00` |
| `ADMIN_EMAIL` | o seu e-mail (o mesmo que vai usar pra criar sua conta) |
| `TZ` | `America/Sao_Paulo` |
| `GEMINI_API_KEY` | chave do Gemini (opcional; veja a seção 6) |

## 4. Conectar o chip do sistema

1. Abra o site e **crie sua conta com o e-mail do `ADMIN_EMAIL`**.
2. No topo aparece **📱 Número do sistema** (só pra você). Clique e depois em **Gerar QR code**.
3. No celular do chip: **Configurações → Dispositivos conectados → Conectar dispositivo** e escaneie.
4. Depois disso, confirme o **seu** número pessoal na tela inicial, como qualquer usuário.

A janela do admin também mostra quantas contas existem, quantos lembretes estão ativos, quantos avisos estão na fila e quantos saíram hoje.

## 5. UptimeRobot

Crie um monitor HTTP(s) apontando pra `https://SEU-APP.onrender.com/health`, a cada 5 minutos.

## 6. Gemini (sugestões com IA)

1. Entre em **aistudio.google.com** com sua conta Google → **Get API key** → **Create API key**.
2. Cole a chave em `GEMINI_API_KEY` no Render.

Como funciona:
- **Privacidade:** pro Gemini vai só o **tipo** da conta (ex.: "conta de luz") e o tom. Nunca o nome, número, valor ou data da pessoa. A IA escreve com marcadores (`{nome}`, `{conta}`...), e o sistema troca pelos dados reais só na hora de enviar. Isso importa porque, no plano grátis, o Google pode usar o que é enviado pra melhorar os produtos dele.
- **Sugestões descartadas:** o sistema joga fora as sugestões que inventam marcadores (tipo `{link}`), que não dizem qual conta vence nem quando, ou que são longas demais.
- **Limites:** no máximo 15 sugestões por pessoa por hora e 8 por minuto no total. A cota grátis do Gemini é por projeto, então isso evita que uma pessoa gaste a de todo mundo.
- **Sem chave, sem cota ou se o Gemini falhar:** o botão continua funcionando, com mensagens prontas no tom escolhido e um aviso discreto.
- **Modelos:** o Google troca os modelos com frequência. O sistema tenta uma lista, do mais leve ao mais novo, e guarda o primeiro que responder. Se um dia nenhum funcionar, o log mostra "nenhum modelo da lista respondeu". Aí é só colocar o nome de um modelo atual em `GEMINI_MODELO`.

## 7. API oficial do WhatsApp (quando crescer)

Por padrão o sistema usa o seu chip (QR code). Com muitos clientes, o mais seguro é a **API oficial da Meta**: botões de verdade e sem risco de bloqueio por automação. Ela cobra por aviso enviado (mensagem de modelo de utilidade). Pra trocar, é só configurar abaixo e mudar `WHATSAPP_PROVEDOR` pra `oficial`. Pra voltar, coloque `baileys`.

1. **Empresa na Meta:** em business.facebook.com, crie (ou use) o Portfólio empresarial e faça a verificação da empresa (CNPJ do MEI serve).
2. **App:** em developers.facebook.com → Criar app → tipo **Empresa** → adicione o produto **WhatsApp**.
3. **Número:** em WhatsApp → Configuração da API, adicione um número que **não** esteja no app do WhatsApp (pode ser um chip novo). Copie o **ID do número de telefone** → `WHATSAPP_PHONE_ID`.
4. **Token permanente:** Configurações do negócio → Usuários do sistema → crie um usuário (admin) → Gerar token, com as permissões `whatsapp_business_messaging` e `whatsapp_business_management` → `WHATSAPP_TOKEN`. (O token temporário do painel vence em 24h.)
5. **Modelos** (WhatsApp Manager → Modelos de mensagem), idioma **Português (BR)**:

| Nome | Categoria | Conteúdo |
|---|---|---|
| `lembrete_conta` | Utilidade | Corpo: `Oi, {{1}}! Lembrete da conta *{{2}}*: {{3}}.` · Rodapé: `Lembra Aí` · Botões de resposta rápida, **nesta ordem**: `Já paguei` e `Me lembra mais tarde` · Exemplos: `Marina` / `Conta de luz de R$ 187,40` / `vence amanhã, dia 10/12` |
| `codigo_confirmacao` | Autenticação | Modelo padrão de código, com o botão **Copiar código** |
| `lembrete_personalizado` (opcional) | Utilidade | Corpo: `Lembrete do Lembra Aí: {{1}} Use os botões abaixo pra responder.` · mesmos 2 botões. Usado quando a pessoa (Premium) escreveu a própria mensagem. Sem ele, vai o `lembrete_conta`. |

6. **Webhook:** no app → WhatsApp → Configuração → Webhook: URL `https://SEU-SITE.onrender.com/webhook/whatsapp`, token de verificação = o mesmo de `WHATSAPP_VERIFY_TOKEN` (invente uma senha). Assine o campo **messages**. Em Configurações do app → Básico, copie a **Chave secreta do app** → `WHATSAPP_APP_SECRET` (o sistema confere a assinatura de cada evento).
7. **Render:**

| Variável | Valor |
|---|---|
| `WHATSAPP_PROVEDOR` | `oficial` |
| `WHATSAPP_TOKEN` | token permanente do passo 4 |
| `WHATSAPP_PHONE_ID` | ID do número do passo 3 |
| `WHATSAPP_VERIFY_TOKEN` | a senha que você inventou no passo 6 |
| `WHATSAPP_APP_SECRET` | chave secreta do app |
| `WHATSAPP_NUMERO` | o número, só dígitos com 55 (aparece no site pra pessoa salvar) |
| `WHATSAPP_MODELO_PERSONALIZADO` | `lembrete_personalizado` (só se criou esse modelo) |

**Como fica:** o aviso chega com os botões **Já paguei** e **Me lembra mais tarde**. O "mais tarde" abre uma lista com os horários. O "Pagamento anotado" vem com o botão **Desfazer**. O código de confirmação vem com o botão de copiar. Quem já confirmou o número não precisa confirmar de novo.

## 8. Pagamento automático com o Asaas

Com o Asaas ligado, o botão **Assinar o Premium** cria a assinatura e leva a pessoa pra fatura do Asaas, onde ela paga com Pix, boleto ou cartão. Quando o pagamento entra, o Premium liga sozinho e chega uma mensagem no WhatsApp dela.

**Como funciona**
- **CPF:** na primeira vez, o site pede o CPF ou CNPJ de quem vai pagar, porque o Asaas exige pra emitir a cobrança. O número vai direto pro Asaas e **não fica no nosso banco**: lá fica só o código do cliente e da assinatura.
- **Liberação:** o Premium vale até o fim do período pago, mais 3 dias de folga pra renovação cair. Cada pagamento conta uma vez só, mesmo que o Asaas mande "confirmado" e depois "recebido".
- **Estorno ou chargeback:** desliga o Premium daquele período. Se ainda houver outro pagamento valendo, ele fica até o fim desse outro.
- **Cancelar:** a pessoa cancela no menu da conta (**Cancelar assinatura**). As cobranças param e o Premium segue até o fim do que já foi pago. Excluir a conta também cancela a assinatura.
- **Fatura em aberto:** se a pessoa fechar a fatura sem pagar, o painel mostra **Pagar agora**. Clicar em "Assinar" de novo reabre a mesma fatura, sem criar outra cobrança.
- **Admin:** a busca de contas mostra a situação da assinatura. Os botões de liberar à mão continuam funcionando (Premium "sem prazo" dado à mão não é mexido pelos pagamentos).

**Passo a passo (primeiro no teste)**
1. Crie uma conta no **Sandbox** do Asaas (ambiente de testes, com dinheiro de mentira) e gere a chave em **Integrações → Chaves de API**. Ela começa com `$aact_hmlg_`.
2. Rode `npm run gerar-token` e copie o token. (**Não** use o `gerar-chave` aqui: ele cria uma CHAVE_DADOS nova, e trocar essa chave num site que já tem dados faz o servidor parar.)
3. No Render, em **Environment**, coloque as variáveis da tabela abaixo e salve.
4. No Asaas, em **Integrações → Webhooks**, crie um webhook:
   - URL: `https://SEU-SITE/webhook/asaas` (ex.: `https://lembra-ai.com/webhook/asaas`)
   - Token de autenticação: o token do passo 2
   - Versão da API: v3. Fila de sincronização: ligada.
   - Eventos: os de **Cobranças** (pelo menos confirmada, recebida, estornada, chargeback e removida) e os de **Assinaturas** (removida e inativada).
5. Rode no Supabase o `supabase.sql` de novo (cria as colunas e as tabelas do Asaas).
6. Teste: assine com o CPF de teste, pague a fatura no Sandbox (lá tem botão pra simular o pagamento) e veja o Premium ligar.
7. Pra valer: crie a conta de verdade (com o CNPJ do MEI), gere a chave de produção (`$aact_prod_`), troque `ASAAS_API_KEY`, mude `ASAAS_AMBIENTE` pra `producao` e crie o webhook de novo na conta de produção.

| Variável | O que colocar |
|---|---|
| `ASAAS_API_KEY` | a chave de API (`$aact_hmlg_...` no teste, `$aact_prod_...` valendo) |
| `ASAAS_AMBIENTE` | `sandbox` ou `producao` |
| `ASAAS_WEBHOOK_TOKEN` | o token do passo 2, igual ao do webhook no Asaas |

**Se o servidor parar com "Dado cifrado com uma chave que o servidor não tem (xxxxxxxx)":** a `CHAVE_DADOS` do Render foi trocada. Volte a chave antiga. Pra descobrir qual das suas chaves guardadas é a certa, rode `npm run conferir-chave -- "CHAVE"`: a certa mostra o mesmo código da mensagem de erro.

**Cuidado:** o Asaas desativa a chave de API que fica muito tempo sem uso, e o pagamento para de funcionar. Se isso acontecer, reative a chave em **Integrações → Chaves de API** ou gere uma nova e troque no Render.

## Cuidados

- **Chip:** use um chip só pro sistema, nunca o seu número principal. O Baileys é **não oficial**, e um número mandando mensagem pra muita gente chama mais atenção do WhatsApp do que o uso pessoal.
- **Spam:** peça pros usuários **salvarem o número do sistema** nos contatos. A tela de confirmação já mostra o número e dá essa dica. Contato salvo diminui bastante a chance de o WhatsApp tratar como spam.
- **Sistema fora do ar:** os avisos esperam e saem quando ele voltar. Se atrasarem mais de 12h, são descartados (ajustável em `MAX_ATRASO_MIN`) e aparecem como "Não enviado" no histórico da pessoa.
- **LGPD:** o site tem **Termos de uso** (`/termos`) e **Política de privacidade** (`/privacidade`). O cadastro exige marcar que aceita (fica guardado a versão e a data do aceite). No menu da conta, a pessoa pode **baixar os dados** dela (JSON) e **excluir a conta** (pede a senha e apaga tudo na hora). Preencha `RESPONSAVEL_NOME`, `CONTATO_EMAIL` e, se tiver, `RESPONSAVEL_DOCUMENTO` no Render. Os textos foram escritos com base na LGPD e no CDC, mas vale uma revisão de um advogado antes de vender o Premium em escala.
- **Cartão:** o sistema não recebe nem guarda dados de cartão (o pagamento do Premium acontece na plataforma de pagamento). Se alguém tentar colocar um número de cartão no nome ou na mensagem de um lembrete, o servidor recusa.
