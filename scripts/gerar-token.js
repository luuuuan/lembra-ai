// Gera o token do webhook do Asaas (32 a 255 caracteres, sem espaços). Não mexe em nenhuma outra chave.
// Uso: npm run gerar-token
import { randomBytes } from 'node:crypto';

console.log('\nToken do webhook do Asaas (ASAAS_WEBHOOK_TOKEN):\n');
console.log(randomBytes(36).toString('base64url'));
console.log('\nColoque o mesmo valor no Render (ASAAS_WEBHOOK_TOKEN) e no Asaas, no campo "Token de autenticação" do webhook.\n');
