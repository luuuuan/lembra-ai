import { createClient } from '@supabase/supabase-js';

const urlBruta = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!urlBruta || !key) {
  console.error('Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY nas variáveis de ambiente.');
  process.exit(1);
}

// Aceita a URL mesmo colada com caminho no final (ex.: .../rest/v1/) — usa só https://xxxx.supabase.co
let url;
try {
  url = new URL(urlBruta).origin;
} catch {
  console.error(`SUPABASE_URL inválida: "${urlBruta}". Use o formato https://xxxx.supabase.co`);
  process.exit(1);
}
if (url !== urlBruta.replace(/\/+$/, '')) console.warn(`SUPABASE_URL ajustada para ${url}`);

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const BUCKET_FOTOS = 'fotos';
