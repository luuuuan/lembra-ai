// Gera uma chave nova pra CHAVE_DADOS (32 bytes aleatórios, em base64).
// Uso: npm run gerar-chave
// ATENÇÃO: só use na PRIMEIRA instalação. Trocar a CHAVE_DADOS de um site que já tem dados faz o servidor
// parar (os dados estão cifrados com a chave antiga). Pra trocar de chave, coloque a antiga em CHAVE_DADOS_ANTIGAS.
// Pra gerar só o token do webhook do Asaas, use: npm run gerar-token
import { randomBytes } from 'node:crypto';

console.log('\n⚠️  Só use esta chave na PRIMEIRA instalação. Se o site já tem dados, NÃO troque a CHAVE_DADOS.');
console.log('   (Precisa só do token do Asaas? Rode: npm run gerar-token)\n');
console.log('Sua chave nova (copie a linha inteira):\n');
console.log(randomBytes(32).toString('base64'));
console.log('\nColoque no Render em Environment -> CHAVE_DADOS.');
console.log('Guarde uma cópia num lugar seguro (gerenciador de senhas): sem ela, os dados cifrados não podem ser lidos.\n');
