/*
 * Códigos QR, para dar de alta una app de autenticación (TOTP) escaneando en
 * vez de teclear el secreto. Solo lo que hace falta aquí: modo byte, corrección
 * de errores M, versiones 1 a 10 (hasta 213 bytes; una dirección otpauth:// son
 * unos 130) y la máscara de menor penalización.
 *
 * Sigue el algoritmo del «QR Code generator library» de Project Nayuki (MIT,
 * https://www.nayuki.io/page/qr-code-generator-library), reescrito y recortado.
 * Sale como SVG, que la página pinta como imagen data: (la CSP lo admite y no
 * hace falta {@html}). El QR lleva el secreto: se genera en el servidor y no
 * sale a ningún servicio de fuera.
 */

/* Corrección M, índice = versión (el 0 no se usa). */
const ECC_POR_BLOQUE = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOQUES = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const BITS_FORMATO_M = 0;
const VERSION_MAX = 10;

function modulosDeDatos(v: number): number {
	let r = (16 * v + 128) * v + 64;
	if (v >= 2) {
		const n = Math.floor(v / 7) + 2;
		r -= (25 * n - 10) * n - 55;
		if (v >= 7) r -= 36;
	}
	return r;
}

const palabrasDeDatos = (v: number) =>
	Math.floor(modulosDeDatos(v) / 8) - ECC_POR_BLOQUE[v] * BLOQUES[v];

/* Multiplicación en GF(2^8) con el polinomio 0x11D. */
function mul(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z;
}

function divisor(grado: number): number[] {
	const r = new Array<number>(grado).fill(0);
	r[grado - 1] = 1;
	let raiz = 1;
	for (let i = 0; i < grado; i++) {
		for (let j = 0; j < r.length; j++) {
			r[j] = mul(r[j], raiz);
			if (j + 1 < r.length) r[j] ^= r[j + 1];
		}
		raiz = mul(raiz, 0x02);
	}
	return r;
}

function resto(datos: number[], div: number[]): number[] {
	const r = new Array<number>(div.length).fill(0);
	for (const b of datos) {
		const f = b ^ (r.shift() as number);
		r.push(0);
		div.forEach((c, i) => (r[i] ^= mul(c, f)));
	}
	return r;
}

function conCorreccion(datos: number[], v: number): number[] {
	const nBloques = BLOQUES[v];
	const ecc = ECC_POR_BLOQUE[v];
	const total = Math.floor(modulosDeDatos(v) / 8);
	const cortos = nBloques - (total % nBloques);
	const largoCorto = Math.floor(total / nBloques);
	const div = divisor(ecc);
	const bloques: number[][] = [];
	for (let i = 0, k = 0; i < nBloques; i++) {
		const d = datos.slice(k, k + largoCorto - ecc + (i < cortos ? 0 : 1));
		k += d.length;
		const e = resto(d, div);
		if (i < cortos) d.push(0);
		bloques.push(d.concat(e));
	}
	const r: number[] = [];
	for (let i = 0; i < bloques[0].length; i++)
		bloques.forEach((b, j) => {
			if (i !== largoCorto - ecc || j >= cortos) r.push(b[i]);
		});
	return r;
}

function posicionesAlineacion(v: number, lado: number): number[] {
	if (v === 1) return [];
	const n = Math.floor(v / 7) + 2;
	const paso = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
	const r = [6];
	for (let p = lado - 7; r.length < n; p -= paso) r.splice(1, 0, p);
	return r;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

const MASCARAS: ((x: number, y: number) => boolean)[] = [
	(x, y) => (x + y) % 2 === 0,
	(_x, y) => y % 2 === 0,
	(x) => x % 3 === 0,
	(x, y) => (x + y) % 3 === 0,
	(x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
	(x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
	(x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
	(x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
];

/* La penalización de la norma (ISO/IEC 18004 §7.8.3): solo para elegir máscara. */
function penalizacion(m: boolean[][]): number {
	const n = m.length;
	let p = 0;
	const lineas = (get: (i: number, j: number) => boolean) => {
		for (let i = 0; i < n; i++) {
			let largo = 1;
			for (let j = 1; j <= n; j++) {
				if (j < n && get(i, j) === get(i, j - 1)) largo++;
				else {
					if (largo >= 5) p += 3 + (largo - 5);
					largo = 1;
				}
			}
			for (let j = 0; j + 11 <= n; j++) {
				const t = Array.from({ length: 11 }, (_, k) => get(i, j + k));
				const a = [true, false, true, true, true, false, true, false, false, false, false];
				if (a.every((b, k) => b === t[k]) || [...a].reverse().every((b, k) => b === t[k])) p += 40;
			}
		}
	};
	lineas((i, j) => m[i][j]);
	lineas((i, j) => m[j][i]);
	for (let y = 0; y + 1 < n; y++)
		for (let x = 0; x + 1 < n; x++) {
			const c = m[y][x];
			if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
		}
	const oscuros = m.reduce((s, f) => s + f.filter(Boolean).length, 0);
	const k = Math.ceil(Math.abs(oscuros * 20 - n * n * 10) / (n * n)) - 1;
	return p + k * 10;
}

/* La matriz del QR (true = módulo oscuro). `mascara` fija una (pruebas); si no, la mejor. */
export function matrizQr(texto: string, mascara?: number): boolean[][] {
	const bytes = [...new TextEncoder().encode(texto)];
	let v = 1;
	for (; v <= VERSION_MAX; v++) {
		const bitsCuenta = v <= 9 ? 8 : 16;
		if (4 + bitsCuenta + bytes.length * 8 <= palabrasDeDatos(v) * 8) break;
	}
	if (v > VERSION_MAX) throw new Error('Text too long for a QR code');

	/* Datos: modo byte (0100), longitud, bytes, fin y relleno. */
	const bits: number[] = [];
	const poner = (x: number, n: number) => {
		for (let i = n - 1; i >= 0; i--) bits.push((x >>> i) & 1);
	};
	poner(4, 4);
	poner(bytes.length, v <= 9 ? 8 : 16);
	for (const b of bytes) poner(b, 8);
	const capacidad = palabrasDeDatos(v) * 8;
	poner(0, Math.min(4, capacidad - bits.length));
	poner(0, (8 - (bits.length % 8)) % 8);
	for (let relleno = 0xec; bits.length < capacidad; relleno ^= 0xec ^ 0x11) poner(relleno, 8);
	const datos: number[] = [];
	for (let i = 0; i < bits.length; i += 8)
		datos.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
	const palabras = conCorreccion(datos, v);

	const lado = v * 4 + 17;
	const m: boolean[][] = Array.from({ length: lado }, () => new Array<boolean>(lado).fill(false));
	const fija: boolean[][] = Array.from({ length: lado }, () =>
		new Array<boolean>(lado).fill(false)
	);
	const set = (x: number, y: number, oscuro: boolean) => {
		m[y][x] = oscuro;
		fija[y][x] = true;
	};

	for (let i = 0; i < lado; i++) {
		set(6, i, i % 2 === 0);
		set(i, 6, i % 2 === 0);
	}
	for (const [cx, cy] of [
		[3, 3],
		[lado - 4, 3],
		[3, lado - 4]
	])
		for (let dy = -4; dy <= 4; dy++)
			for (let dx = -4; dx <= 4; dx++) {
				const d = Math.max(Math.abs(dx), Math.abs(dy));
				const x = cx + dx;
				const y = cy + dy;
				if (x >= 0 && x < lado && y >= 0 && y < lado) set(x, y, d !== 2 && d !== 4);
			}
	const al = posicionesAlineacion(v, lado);
	for (let i = 0; i < al.length; i++)
		for (let j = 0; j < al.length; j++) {
			if (
				(i === 0 && j === 0) ||
				(i === 0 && j === al.length - 1) ||
				(i === al.length - 1 && j === 0)
			)
				continue;
			for (let dy = -2; dy <= 2; dy++)
				for (let dx = -2; dx <= 2; dx++)
					set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
		}

	const formato = (mk: number) => {
		const d = (BITS_FORMATO_M << 3) | mk;
		let r = d;
		for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
		const b = ((d << 10) | r) ^ 0x5412;
		for (let i = 0; i <= 5; i++) set(8, i, bit(b, i));
		set(8, 7, bit(b, 6));
		set(8, 8, bit(b, 7));
		set(7, 8, bit(b, 8));
		for (let i = 9; i < 15; i++) set(14 - i, 8, bit(b, i));
		for (let i = 0; i < 8; i++) set(lado - 1 - i, 8, bit(b, i));
		for (let i = 8; i < 15; i++) set(8, lado - 15 + i, bit(b, i));
		set(8, lado - 8, true);
	};
	formato(0);
	if (v >= 7) {
		let r = v;
		for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
		const b = (v << 12) | r;
		for (let i = 0; i < 18; i++) {
			const a = lado - 11 + (i % 3);
			const c = Math.floor(i / 3);
			set(a, c, bit(b, i));
			set(c, a, bit(b, i));
		}
	}

	let i = 0;
	for (let der = lado - 1; der >= 1; der -= 2) {
		if (der === 6) der = 5;
		for (let vert = 0; vert < lado; vert++)
			for (let j = 0; j < 2; j++) {
				const x = der - j;
				const arriba = ((der + 1) & 2) === 0;
				const y = arriba ? lado - 1 - vert : vert;
				if (!fija[y][x] && i < palabras.length * 8) {
					m[y][x] = bit(palabras[i >>> 3], 7 - (i & 7));
					i++;
				}
			}
	}

	const aplicar = (mk: number) => {
		for (let y = 0; y < lado; y++)
			for (let x = 0; x < lado; x++) if (!fija[y][x] && MASCARAS[mk](x, y)) m[y][x] = !m[y][x];
	};
	let mejor = mascara ?? 0;
	if (mascara === undefined) {
		let menor = Infinity;
		for (let mk = 0; mk < 8; mk++) {
			aplicar(mk);
			formato(mk);
			const p = penalizacion(m);
			if (p < menor) {
				menor = p;
				mejor = mk;
			}
			aplicar(mk);
		}
	}
	aplicar(mejor);
	formato(mejor);
	return m;
}

/* El QR como SVG, con su margen de cuatro módulos. */
export function qrSvg(texto: string): string {
	const m = matrizQr(texto);
	const n = m.length + 8;
	let d = '';
	m.forEach((fila, y) =>
		fila.forEach((o, x) => {
			if (o) d += `M${x + 4} ${y + 4}h1v1h-1z`;
		})
	);
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
		`<rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
	);
}

/* Como imagen data:, para un <img>. */
export const qrDataUri = (texto: string) =>
	`data:image/svg+xml;base64,${Buffer.from(qrSvg(texto)).toString('base64')}`;
