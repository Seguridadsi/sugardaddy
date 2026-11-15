/*
 * Salida a internet del nodo (docs/diseno/proxy-salida.md): si sale por un proxy
 * (hecho proxy.presente) y una prueba de alcance por destino, que sube en el latido
 * para que el panel vea qué falla sin entrar en la máquina.
 *
 * Los destinos son solo los de SeguridadSI y Microsoft que este nodo usa: ni
 * direcciones del cliente ni la del proxy (que puede llevar su contraseña).
 *
 * La prueba sale como sale todo lo demás de la consola: por el proxy de su entorno
 * (NODE_USE_ENV_PROXY) y fiándose de su CA (NODE_EXTRA_CA_CERTS). Cualquier
 * respuesta HTTP cuenta como alcanzado (el registro contesta 401 sin credencial);
 * lo que falla es no llegar: DNS, conexión, el proxy que no deja, un TLS que no casa.
 */
import { env } from '$env/dynamic/private';

export type Alcance = { destino: string; ok: boolean; detalle: string | null };
export type Salida = { proxy: boolean; destinos: Alcance[]; cuando: string };

/* Cada cuánto se repite, y cuánto espera cada destino. */
const CADA_MS = 30 * 60_000;
const ESPERA_MS = 10_000;
export const MAX_DESTINOS = 8;

export function proxyPresente(e: Record<string, string | undefined> = env): boolean {
	return !!(e.HTTPS_PROXY || e.https_proxy);
}

/* Lo que se prueba: el nombre (lo que se enseña) y la URL. Sin panel ni Entra, no se prueban. */
export function destinos(
	panel: string | null,
	e: Record<string, string | undefined> = env
): { destino: string; url: string }[] {
	const r: { destino: string; url: string }[] = [];
	const anadir = (url: string, ruta = '/') => {
		try {
			const u = new URL(url);
			if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
			if (r.some((d) => d.destino === u.host)) return;
			r.push({ destino: u.host, url: `${u.origin}${ruta}` });
		} catch {
			/* mal escrita: no se prueba */
		}
	};
	if (panel) anadir(panel, '/');
	const registro = (e.REGISTRO ?? '').trim();
	if (/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(registro)) anadir(`https://${registro}`, '/v2/');
	if (e.ENTRA_TENANT_ID) anadir('https://login.microsoftonline.com', '/common/discovery/keys');
	return r.slice(0, MAX_DESTINOS);
}

/* Por qué no se llegó, en pocas palabras y sin la URL del proxy (puede llevar la contraseña). */
export function motivo(e: unknown): string {
	/*
	 * fetch lo envuelve: «fetch failed» → «Request was cancelled» → «Proxy response (407)…».
	 * Se mira toda la cadena de causas: el código es el primero que sea texto.
	 */
	const cadena: { code?: unknown; message?: unknown }[] = [];
	for (let c = e as { cause?: unknown } | undefined, i = 0; c && i < 5; i++) {
		cadena.push(c as { code?: unknown; message?: unknown });
		c = (c as { cause?: unknown }).cause as { cause?: unknown } | undefined;
	}
	const codigo = cadena
		.slice(1)
		.concat(cadena.slice(0, 1))
		.map((c) => c.code)
		.find((c): c is string => typeof c === 'string' && c !== '');
	const texto =
		cadena
			.slice(1)
			.map((c) => String(c.message ?? ''))
			.filter((m) => m && m !== 'fetch failed')
			.join(': ') || String((e as Error)?.message ?? e);
	if ((e as Error)?.name === 'TimeoutError' || codigo === 'UND_ERR_CONNECT_TIMEOUT')
		return 'no answer in time';
	if (/Proxy response \(407\)/.test(texto) || /\b407\b/.test(texto))
		return 'the proxy asks for authentication (407)';
	if (/\b(403|502|503)\b/.test(texto) && /proxy|tunnel|CONNECT/i.test(texto))
		return `the proxy refused it (${texto.match(/\b(403|502|503)\b/)?.[0]})`;
	if (codigo === 'ENOTFOUND' || codigo === 'EAI_AGAIN') return 'the name does not resolve';
	if (codigo === 'ECONNREFUSED') return 'connection refused';
	if (codigo === 'ECONNRESET') return 'connection reset';
	if (codigo && /CERT|SELF_SIGNED|UNABLE_TO|TLS|SSL/i.test(codigo))
		return `TLS not trusted (${codigo}): if the proxy inspects TLS, install its CA`;
	return (codigo ? `${codigo}: ` : '') + texto.replace(/https?:\/\/[^\s]*@/g, '***@').slice(0, 120);
}

export async function probar(
	lista: { destino: string; url: string }[],
	pedir: typeof fetch = fetch
): Promise<Alcance[]> {
	return Promise.all(
		lista.map(async ({ destino, url }) => {
			try {
				const r = await pedir(url, {
					method: 'GET',
					redirect: 'manual',
					signal: AbortSignal.timeout(ESPERA_MS),
					headers: { 'user-agent': 'sugardaddy-node' }
				});
				await r.body?.cancel().catch(() => {});
				return { destino, ok: true, detalle: null };
			} catch (e) {
				return { destino, ok: false, detalle: motivo(e) };
			}
		})
	);
}

let ultima: Salida | null = null;
let enCurso: Promise<Salida> | null = null;

/* Lo último sabido; si es viejo (o no hay), lanza otra prueba sin esperarla. */
export function salidaParaLatido(panel: string | null): Salida | null {
	if (!enCurso && (!ultima || Date.now() - Date.parse(ultima.cuando) > CADA_MS))
		void probarAhora(panel).catch(() => {});
	return ultima;
}

export async function probarAhora(panel: string | null): Promise<Salida> {
	enCurso ??= (async () => {
		try {
			ultima = {
				proxy: proxyPresente(),
				destinos: await probar(destinos(panel)),
				cuando: new Date().toISOString()
			};
			return ultima;
		} finally {
			enCurso = null;
		}
	})();
	return enCurso;
}

/* Para las pruebas. */
export function _olvidarSalida() {
	ultima = null;
	enCurso = null;
}
