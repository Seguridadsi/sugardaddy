/*
 * Los campos de texto de la consola y del panel no son credenciales, pero los
 * gestores de contraseñas (1Password, Bitwarden, LastPass, Dashlane y el del
 * navegador) se ofrecen en cualquiera que se llame «Name» o «User», y su
 * desplegable tapa la página. Esto es un preprocesador de Svelte: al compilar,
 * le pone a TODO <input> y <textarea> de texto lo que hace que lo ignoren. No
 * hay que acordarse de nada al escribir un campo nuevo.
 *
 * El gestor solo se queda donde el campo lo pide:
 *   - con un `autocomplete` que diga de quién es el dato (username,
 *     current-password, one-time-code, email, name…): entrar en la consola;
 *   - o con el atributo `data-con-gestor`: el campo se deja exactamente como está
 *     (elegir una contraseña nueva, el alta de usuarios).
 * Cuáles son lo vigila sin-gestor.spec.ts, con su lista.
 *
 * «off» y «new-password» no lo piden: es lo que lleva un secreto de una
 * integración (token, clave de API), que es type="password" y no es la
 * contraseña de nadie. Sale con «new-password», que es lo único con lo que el
 * navegador no rellena ahí la contraseña guardada del sitio, y con las marcas.
 */

/* Los tipos en los que no se escribe texto: ningún gestor los mira. */
const SIN_TEXTO = new Set([
	'hidden',
	'checkbox',
	'radio',
	'file',
	'range',
	'color',
	'submit',
	'button',
	'reset',
	'image'
]);

/* Los valores de autocomplete que no dicen de quién es el dato. */
const NO_LO_PIDEN = new Set(['off', 'new-password']);

/* Lo que cada gestor entiende como «este campo no es mío». */
export const MARCAS = [
	['data-1p-ignore', null],
	['data-lpignore', 'true'],
	['data-bwignore', null],
	['data-form-type', 'other']
];

/** El final de una expresión {…} de Svelte que empieza en `i` (la llave de apertura). */
function finDeLlaves(t, i) {
	let hondo = 0;
	for (; i < t.length; i++) {
		const c = t[i];
		if (c === '"' || c === "'" || c === '`') {
			/* Una cadena dentro de la expresión: sus llaves y sus «>» no cuentan. */
			for (i++; i < t.length && t[i] !== c; i++) if (t[i] === '\\') i++;
		} else if (c === '{') hondo++;
		else if (c === '}' && --hondo === 0) return i;
	}
	return t.length;
}

/**
 * Los atributos de una etiqueta que empieza en `desde` (justo tras su nombre).
 * Devuelve dónde se cierra y lo que dice cada atributo: su valor si es un texto
 * fijo, `true` si no lleva valor y `undefined` si es una expresión.
 */
function leerEtiqueta(t, desde) {
	const atributos = new Map();
	let i = desde;
	while (i < t.length) {
		const c = t[i];
		if (c === '>') return { fin: i, cierre: i, atributos };
		if (c === '/' && t[i + 1] === '>') return { fin: i + 1, cierre: i, atributos };
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (c === '{') {
			/* {...resto} o {nombre}: no se sabe qué trae. */
			i = finDeLlaves(t, i) + 1;
			continue;
		}
		const m = /^[^\s=>/{]+/.exec(t.slice(i, i + 200));
		if (!m) {
			i++;
			continue;
		}
		const nombre = m[0];
		i += nombre.length;
		if (t[i] !== '=') {
			atributos.set(nombre, { valor: true });
			continue;
		}
		const inicio = ++i;
		if (t[i] === '{') {
			i = finDeLlaves(t, i) + 1;
			atributos.set(nombre, { valor: undefined });
		} else if (t[i] === '"' || t[i] === "'") {
			const q = t[i];
			let fijo = true;
			for (i++; i < t.length && t[i] !== q; i++)
				if (t[i] === '{') {
					fijo = false;
					i = finDeLlaves(t, i);
				}
			atributos.set(nombre, {
				valor: fijo ? t.slice(inicio + 1, i) : undefined,
				de: inicio,
				a: i + 1
			});
			i++;
		} else {
			const v = /^[^\s>]+/.exec(t.slice(i, i + 200))?.[0] ?? '';
			i += v.length;
			atributos.set(nombre, { valor: v, de: inicio, a: i });
		}
	}
	return { fin: t.length, cierre: t.length, atributos };
}

/**
 * Las etiquetas <input> y <textarea> del marcado de un .svelte, sin las que
 * salgan dentro de <script>, <style> o un comentario.
 * @param {string} t
 */
export function campos(t) {
	const encontrados = [];
	const re = /<!--|<(script|style)\b|<(input|textarea)(?=[\s/>])/gi;
	let m;
	while ((m = re.exec(t))) {
		if (m[0] === '<!--') {
			const f = t.indexOf('-->', m.index);
			re.lastIndex = f < 0 ? t.length : f + 3;
		} else if (m[1]) {
			const f = t.toLowerCase().indexOf(`</${m[1].toLowerCase()}`, m.index);
			re.lastIndex = f < 0 ? t.length : f;
		} else {
			const e = leerEtiqueta(t, m.index + m[0].length);
			encontrados.push({ etiqueta: m[2].toLowerCase(), inicio: m.index, ...e });
			re.lastIndex = e.fin + 1;
		}
	}
	return encontrados;
}

/**
 * Qué se hace con un campo: `gestor` si se queda con el gestor de contraseñas,
 * `nada` si no es de texto y `marcar` si hay que ponerle las marcas.
 */
export function decidir(campo) {
	const a = campo.atributos;
	const tipo = a.get('type');
	if (campo.etiqueta === 'input' && typeof tipo?.valor === 'string' && SIN_TEXTO.has(tipo.valor))
		return 'nada';
	if (a.has('data-con-gestor')) return 'gestor';
	const ac = a.get('autocomplete');
	/* Una expresión en autocomplete es de quien la escribió: no se pisa. */
	if (ac && (typeof ac.valor !== 'string' || !NO_LO_PIDEN.has(ac.valor.trim().toLowerCase())))
		return 'gestor';
	return 'marcar';
}

/**
 * El marcado con las marcas puestas.
 * @param {string} t
 */
export function marcar(t) {
	let salida = '';
	let hecho = 0;
	for (const campo of campos(t)) {
		if (decidir(campo) !== 'marcar') continue;
		const a = campo.atributos;
		const secreto = campo.etiqueta === 'input' && a.get('type')?.valor === 'password';
		const ac = a.get('autocomplete');
		const hasta = campo.cierre;
		let trozo = t.slice(hecho, hasta);
		const nuevos = [];
		if (!ac) nuevos.push(`autocomplete="${secreto ? 'new-password' : 'off'}"`);
		else if (secreto && ac.de !== undefined && ac.valor !== 'new-password')
			/* «off» en un type="password" el navegador no lo respeta: new-password sí. */
			trozo = t.slice(hecho, ac.de) + '"new-password"' + t.slice(ac.a, hasta);
		for (const [nombre, valor] of MARCAS)
			if (!a.has(nombre)) nuevos.push(valor === null ? nombre : `${nombre}="${valor}"`);
		salida += trozo;
		if (nuevos.length) salida += (/\s$/.test(trozo) ? '' : ' ') + nuevos.join(' ') + ' ';
		hecho = hasta;
	}
	return salida + t.slice(hecho);
}

/** El preprocesador, para `preprocess` de la configuración de SvelteKit. */
export function sinGestor() {
	return {
		name: 'sin-gestor-de-contrasenas',
		/** @param {{ content: string, filename?: string }} entrada */
		markup({ content, filename }) {
			if (filename && /[/\\]node_modules[/\\]/.test(filename)) return;
			const code = marcar(content);
			return code === content ? undefined : { code };
		}
	};
}
