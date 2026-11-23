// Gera uma chave nova pra CHAVE_DADOS (32 bytes aleatórios, em base64).
// Uso: npm run gerar-chave
import { randomBytes } from 'node:crypto';

console.log('\nSua chave nova (copie a linha inteira):\n');
console.log(randomBytes(32).toString('base64'));
console.log('\nColoque no Render em Environment -> CHAVE_DADOS.');
console.log('Guarde uma cópia num lugar seguro (gerenciador de senhas): sem ela, os dados cifrados não podem ser lidos.\n');
