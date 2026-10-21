/*
 * IPs y redes (IPv4 e IPv6) como rangos de números, para las listas.
 *
 * La regla de las listas es que la blanca gana siempre. No basta con mirar si
 * la primera dirección de una red negra cae en la blanca: 10.0.0.0/8 en la
 * negra y el controlador de dominio 10.1.1.1 en la blanca solapan aunque
 * 10.0.0.0 no sea blanca. Aquí se resta la blanca a la negra y se devuelve lo
 * que queda como redes CIDR: el firewall bloquea todo menos lo blanco.
 */
import { isIP } from 'node:net';

export type Rango = { familia: 4 | 6; desde: bigint; hasta: bigint };

const BITS = { 4: 32, 6: 128 } as const;

function numeroDe(ip: string): { familia: 4 | 6; n: bigint } | null {
	const v = isIP(ip);
	if (v === 4) return { familia: 4, n: ip.split('.').reduce((a, o) => (a << 8n) + BigInt(o), 0n) };
	if (v !== 6) return null;
	let texto = ip.toLowerCase();
	/* Una IPv4 al final (::ffff:10.1.1.1) son los dos últimos grupos. */
	const v4 = texto.match(/(\d+\.\d+\.\d+\.\d+)$/);
	if (v4) {
		const n = numeroDe(v4[1])!.n;
		texto =
			texto.slice(0, -v4[1].length) + `${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
	}
	const [izq, der] = texto.split('::');
	const a = izq ? izq.split(':') : [];
	const b = der !== undefined && der ? der.split(':') : [];
	const grupos = der === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
	return { familia: 6, n: grupos.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n) };
}

/* Una IP o una red en CIDR como rango; null si no lo es. La base se alinea a la máscara. */
export function rango(entrada: string): Rango | null {
	const [base, mascara] = entrada.split('/');
	const ip = numeroDe(base);
	if (!ip) return null;
	const total = BITS[ip.familia];
	const bits = mascara === undefined ? total : Number(mascara);
	if (
		!Number.isInteger(bits) ||
		bits < 0 ||
		bits > total ||
		(mascara !== undefined && !/^\d+$/.test(mascara))
	)
		return null;
	const tam = 1n << BigInt(total - bits);
	const desde = (ip.n / tam) * tam;
	return { familia: ip.familia, desde, hasta: desde + tam - 1n };
}

function textoDe(familia: 4 | 6, n: bigint): string {
	if (familia === 4) return [24n, 16n, 8n, 0n].map((d) => ((n >> d) & 0xffn).toString()).join('.');
	const g = Array.from({ length: 8 }, (_, i) =>
		((n >> BigInt(112 - 16 * i)) & 0xffffn).toString(16)
	);
	/* La racha de ceros más larga (de al menos dos grupos) se abrevia con :: */
	let mejor = { i: -1, l: 0 };
	for (let i = 0; i < 8;) {
		if (g[i] !== '0') {
			i++;
			continue;
		}
		let j = i;
		while (j < 8 && g[j] === '0') j++;
		if (j - i > mejor.l && j - i > 1) mejor = { i, l: j - i };
		i = j;
	}
	if (mejor.i < 0) return g.join(':');
	return `${g.slice(0, mejor.i).join(':')}::${g.slice(mejor.i + mejor.l).join(':')}`;
}

/* Un rango como la lista mínima de redes CIDR que lo cubren exactamente. */
export function aCidrs(r: Rango): string[] {
	const total = BigInt(BITS[r.familia]);
	const salida: string[] = [];
	let a = r.desde;
	while (a <= r.hasta) {
		/* El bloque más grande alineado en a que no se pasa de hasta. */
		let k = 0n;
		while (k < total && a % (1n << (k + 1n)) === 0n && a + (1n << (k + 1n)) - 1n <= r.hasta) k++;
		salida.push(k === 0n ? textoDe(r.familia, a) : `${textoDe(r.familia, a)}/${total - k}`);
		a += 1n << k;
	}
	return salida;
}

/* ¿Está esta IP (o red) entera dentro de alguna de estas IPs o redes? */
export function contenidaEn(ip: string, entradas: string[]): boolean {
	const r = rango(ip);
	if (!r) return entradas.includes(ip);
	return entradas.some((e) => {
		const x = rango(e);
		return !!x && x.familia === r.familia && x.desde <= r.desde && r.hasta <= x.hasta;
	});
}

/*
 * Lo que queda de una IP o red negra al quitarle todo lo que solapa con la
 * blanca, como redes CIDR. Vacío si la blanca la cubre entera; la misma
 * entrada, tal cual, si no solapa con nada.
 */
export function restar(negra: string, blancas: string[]): string[] {
	const r = rango(negra);
	if (!r) return [negra];
	let trozos: Rango[] = [r];
	for (const b of blancas) {
		const x = rango(b);
		if (!x || x.familia !== r.familia) continue;
		trozos = trozos.flatMap((t) => {
			if (x.hasta < t.desde || x.desde > t.hasta) return [t];
			const quedan: Rango[] = [];
			if (x.desde > t.desde) quedan.push({ ...t, hasta: x.desde - 1n });
			if (x.hasta < t.hasta) quedan.push({ ...t, desde: x.hasta + 1n });
			return quedan;
		});
	}
	if (trozos.length === 1 && trozos[0].desde === r.desde && trozos[0].hasta === r.hasta)
		return [negra];
	return trozos.flatMap(aCidrs);
}
