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
- **Pagamento:** coloque o link de assinatura (do Asaas, por exemplo) em `PREMIUM_LINK`. O botão "Assinar o Premium" abre esse link, com `?periodo=mensal` ou `?periodo=anual` no final. Sem o link, a tela avisa que o pagamento online chega em breve.
- **Liberar o Premium:** na janela do admin (**Número do sistema → Planos das contas**), busque o e-mail e escolha "+30 dias", "+1 ano", "sem prazo" ou "Voltar pro Grátis". Renovar soma a partir do fim do período que ainda está valendo.
- **Quando o Premium acaba:** nada é apagado. Funcionam só os 3 lembretes mais antigos, com 1 aviso cada (o mais perto do vencimento) e mensagem padrão. Assinando de novo, tudo volta como era. As contas Premium aparecem com o cadeado e o botão "Liberar com Premium" nos lembretes parados.

## Página de apresentação

Quem abre o site sem estar logado vê a página de apresentação (`public/lp.html`), com como funciona, recursos, planos e dúvidas. Quem está logado vai direto pro painel. Os botões levam pra `/login` e `/login#cadastro`.

## Segurança e detalhes de uso

- **Dados cifrados:** nome, e-mail e telefone (de todo mundo, admin incluído), o nome, valor e mensagem de cada lembrete, o texto dos avisos enviados e a sessão do WhatsApp do sistema ficam cifrados no banco com **AES-256-GCM**. Quem abrir o Supabase só vê `c1.xxxx`. A chave fica só no servidor (`CHAVE_DADOS`).
  - Cada valor fica amarrado à sua tabela, coluna e linha: copiar um dado cifrado de um lugar pro outro não funciona, e qualquer alteração no dado cifrado é detectada.
  - Pra achar a conta no login (e-mail) e quando a pessoa responde no WhatsApp (número), o banco guarda um **índice cego** (HMAC-SHA256 com outra chave derivada): dá pra buscar, mas não dá pra voltar ao dado.
  - Números de quem escreveu sem ter conta também viram índice: o número não fica guardado.
  - Ao subir, o servidor cifra sozinho o que ainda estiver aberto no banco (dados de antes da criptografia).
- **Senhas:** Argon2id (19 MiB de memória, 2 passadas, recomendação da OWASP). As senhas antigas (scrypt) passam pro Argon2id no próximo login da pessoa, sem ela perceber.
- **Trocar a chave:** gere uma nova (`npm run gerar-chave`), coloque a nova em `CHAVE_DADOS` e a antiga em `CHAVE_DADOS_ANTIGAS`. Ao subir, o servidor regrava tudo com a nova. Depois de ver no log que terminou, pode apagar a antiga.
- **Perdeu a chave = perdeu os dados.** Guarde uma cópia da `CHAVE_DADOS` num gerenciador de senhas. Sem ela, nem você consegue ler os dados cifrados.
- **Login:** 5 senhas erradas na mesma conta travam o login dela por 15 minutos. 20 erros vindos do mesmo IP (tentando vários e-mails) também travam por 15 minutos. Cada erro ainda demora meio segundo a mais pra responder, o que deixa o chute de senha bem lento.
- **Cadastro:** no máximo 5 contas novas por hora vindas do mesmo IP.
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

## Cuidados

- **Chip:** use um chip só pro sistema, nunca o seu número principal. O Baileys é **não oficial**, e um número mandando mensagem pra muita gente chama mais atenção do WhatsApp do que o uso pessoal.
- **Spam:** peça pros usuários **salvarem o número do sistema** nos contatos. A tela de confirmação já mostra o número e dá essa dica. Contato salvo diminui bastante a chance de o WhatsApp tratar como spam.
- **Sistema fora do ar:** os avisos esperam e saem quando ele voltar. Se atrasarem mais de 12h, são descartados (ajustável em `MAX_ATRASO_MIN`) e aparecem como "Não enviado" no histórico da pessoa.
- **LGPD:** o site tem **Termos de uso** (`/termos`) e **Política de privacidade** (`/privacidade`). O cadastro exige marcar que aceita (fica guardado a versão e a data do aceite). No menu da conta, a pessoa pode **baixar os dados** dela (JSON) e **excluir a conta** (pede a senha e apaga tudo na hora). Preencha `RESPONSAVEL_NOME`, `CONTATO_EMAIL` e, se tiver, `RESPONSAVEL_DOCUMENTO` no Render. Os textos foram escritos com base na LGPD e no CDC, mas vale uma revisão de um advogado antes de vender o Premium em escala.
- **Cartão:** o sistema não recebe nem guarda dados de cartão (o pagamento do Premium acontece na plataforma de pagamento). Se alguém tentar colocar um número de cartão no nome ou na mensagem de um lembrete, o servidor recusa.
