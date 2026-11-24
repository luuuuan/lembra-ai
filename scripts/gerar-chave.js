// Gera uma chave nova pra CHAVE_DADOS (32 bytes aleatórios, em base64).
// Uso: npm run gerar-chave
import { randomBytes } from 'node:crypto';

console.log('\nSua chave nova (copie a linha inteira):\n');
console.log(randomBytes(32).toString('base64'));
console.log('\nColoque no Render em Environment -> CHAVE_DADOS.');
console.log('Guarde uma cópia num lugar seguro (gerenciador de senhas): sem ela, os dados cifrados não podem ser lidos.\n');

// Token do webhook do Asaas (32 a 255 caracteres, sem espaços): mesmo valor no Render e no Asaas
console.log('Se for ligar o Asaas, aqui vai também um token pro webhook (ASAAS_WEBHOOK_TOKEN):\n');
console.log(randomBytes(36).toString('base64url'));
console.log('\nColoque o mesmo valor no Render (ASAAS_WEBHOOK_TOKEN) e no Asaas, no campo "Token de autenticação" do webhook.\n');
