/*
 * Ningún campo de texto de la consola ni del panel llama al gestor de
 * contraseñas, salvo los de esta lista. Recorre todos los .svelte de las dos
 * aplicaciones tal como salen del preprocesador (sin-gestor.js): un campo nuevo
 * sale marcado solo, y uno nuevo que pida el gestor hace fallar esto hasta que
 * alguien lo apunta aquí a sabiendas.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARCAS, campos, decidir, marcar, sinGestor } from './sin-gestor.js';

const repo = join(import.meta.dirname, '../..');

/*
 * Donde el gestor de contraseñas tiene que funcionar: entrar, cambiar o recuperar
 * la contraseña y dar de alta usuarios; y los pocos campos con datos de la
 * persona (su correo, su nombre) donde el navegador ayuda al rellenarlos.
 * «fichero: campo, campo…», con el name de cada campo («-» si no tiene).
 */
const CON_GESTOR: Record<string, string[]> = {
	'apps/consola/src/routes/sign-in/+page.svelte': ['usuario', 'clave'],
	'apps/consola/src/routes/sign-in/change/+page.svelte': ['-', 'correo', 'clave', 'repetir'],
	'apps/consola/src/routes/sign-in/recover/+page.svelte': [
		'usuario',
		'usuario',
		'codigo',
		'clave',
		'repetir'
	],
	'apps/consola/src/routes/account/+page.svelte': [
		'correo',
		'clave',
		'-',
		'actual',
		'nueva',
		'repetir'
	],
	'apps/consola/src/routes/users/+page.svelte': ['usuario', 'correo', 'clave', 'clave'],
	/* El correo de quien administra, para avisos y registro: lo rellena su navegador. */
	'apps/consola/src/routes/settings/+page.svelte': ['correo'],
	/* Quien atiende un aviso escribe su nombre. */
	'apps/consola/src/routes/alert/[enlace]/+page.svelte': ['nombre'],
	/* La web pública: el correo de quien se registra o se da de baja. */
	'apps/central/src/routes/community/+page.svelte': ['correo'],
	'apps/central/src/routes/register/+page.svelte': ['correo'],
	'apps/central/src/routes/register/unsubscribe/+page.svelte': ['correo']
};

function svelte(carpeta: string): string[] {
	if (!existsSync(carpeta)) return [];
	return readdirSync(carpeta, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? svelte(join(carpeta, e.name))
			: e.name.endsWith('.svelte')
				? [join(carpeta, e.name)]
				: []
	);
}
const ficheros = ['consola', 'central'].flatMap((app) => svelte(join(repo, 'apps', app, 'src')));
const texto = (v: unknown) => (typeof v === 'string' ? v : '-');

describe('el preprocesador', () => {
	it('marca un campo de texto y le apaga el autocompletar', () => {
		expect(marcar('<input name="nombre" required />')).toBe(
			'<input name="nombre" required autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" />'
		);
		expect(marcar('<textarea name="nota"></textarea>')).toBe(
			'<textarea name="nota" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" ></textarea>'
		);
	});

	it('no repite lo que ya está y respeta el autocomplete="off" escrito', () => {
		const t = marcar('<input name="x" autocomplete="off" data-1p-ignore>');
		expect(t).toBe(
			'<input name="x" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" >'
		);
		expect(marcar(t)).toBe(t);
	});

	it('un secreto de una integración sale con new-password, que el navegador sí respeta', () => {
		expect(marcar('<input type="password" name="token" autocomplete="off" />')).toContain(
			'autocomplete="new-password" data-1p-ignore'
		);
		expect(marcar('<input type="password" name="token" />')).toContain(
			'autocomplete="new-password" data-1p-ignore'
		);
		expect(marcar('<input type="password" name="token" autocomplete="new-password" />')).toBe(
			'<input type="password" name="token" autocomplete="new-password" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" />'
		);
	});

	it('deja como están los que piden el gestor y los que no son de texto', () => {
		for (const t of [
			'<input name="usuario" autocomplete="username" />',
			'<input name="clave" type="password" autocomplete="current-password" required />',
			'<input name="clave" type="text" autocomplete="off" data-con-gestor />',
			'<input name="nueva" type="password" autocomplete="new-password" data-con-gestor />',
			'<input name="x" autocomplete={modo} />',
			'<input type="hidden" name="id" value={u.id} />',
			'<input type="checkbox" name="rol" value={rol} checked={u.roles.includes(rol)} />',
			'<input type="file" name="html" />'
		])
			expect(marcar(t)).toBe(t);
	});

	it('entiende las expresiones de Svelte: un «>» o una comilla dentro no cortan la etiqueta', () => {
		const t = `<input
	id="q"
	name="p.{clave}"
	value={a > b ? "x>" : \`{\${c}}\`}
	onkeydown={(ev) => ev.key === 'Enter' && ev.preventDefault()}
	{...resto}
/>`;
		const r = marcar(t);
		expect(r.startsWith(t.slice(0, -2))).toBe(true);
		expect(r).toMatch(/\{\.\.\.resto\}\s+autocomplete="off" data-1p-ignore[^>]*\/>$/);
		/* El tipo que sale de una expresión no se sabe: se marca. */
		expect(marcar("<input type={c.format === 'uri' ? 'url' : 'text'} name=x>")).toContain(
			'data-1p-ignore'
		);
	});

	it('no toca lo que hay en el script, en el estilo ni en un comentario', () => {
		const t = `<script>
	const plantilla = '<input name="a">';
</script>
<!-- <input name="b"> -->
<style>
	input { color: red; }
</style>`;
		expect(marcar(t)).toBe(t);
		expect(campos(`${t}\n<input name="c">`)).toHaveLength(1);
	});

	it('como preprocesador, solo devuelve código cuando cambia algo y no entra en node_modules', () => {
		const p = sinGestor();
		expect(p.markup({ content: '<p>hola</p>', filename: 'a.svelte' })).toBeUndefined();
		expect(p.markup({ content: '<input name="a">', filename: 'a.svelte' })?.code).toContain(
			'data-bwignore'
		);
		expect(
			p.markup({ content: '<input name="a">', filename: '/x/node_modules/y/a.svelte' })
		).toBeUndefined();
	});
});

describe('los campos de la consola y del panel', () => {
	it('hay ficheros que mirar', () => {
		expect(ficheros.length).toBeGreaterThan(50);
	});

	it('todo campo de texto sale marcado, salvo los de la lista', () => {
		const conGestor: Record<string, string[]> = {};
		const sinMarcar: string[] = [];
		for (const f of ficheros) {
			const nombre = relative(repo, f).replace(/\\/g, '/');
			const fuente = readFileSync(f, 'utf8');
			/* Lo que se decide con lo escrito, y cómo sale después del preprocesador. */
			const antes = campos(fuente);
			const despues = campos(marcar(fuente));
			expect(despues.length, nombre).toBe(antes.length);
			antes.forEach((c, i) => {
				const que = decidir(c);
				const name = texto(c.atributos.get('name')?.valor);
				if (que === 'gestor') (conGestor[nombre] ??= []).push(name);
				if (que !== 'marcar') return;
				const sale = despues[i].atributos;
				const faltan = MARCAS.filter(([m]) => !sale.has(m)).map(([m]) => m);
				const ac = sale.get('autocomplete')?.valor;
				const secreto = sale.get('type')?.valor === 'password';
				if (faltan.length || ac !== (secreto ? 'new-password' : 'off'))
					sinMarcar.push(`${nombre}: ${name} (${faltan.join(', ') || `autocomplete=${ac}`})`);
			});
		}
		expect(sinMarcar).toEqual([]);
		/* Solo se compara lo que hay en esta edición: en Community no está el panel. */
		const esperado = Object.fromEntries(
			Object.entries(CON_GESTOR).filter(([f]) => existsSync(join(repo, f)))
		);
		expect(conGestor).toEqual(esperado);
	});

	it('un campo de contraseña dice siempre qué es: de entrar (en la lista) o un secreto', () => {
		const sinDecir: string[] = [];
		for (const f of ficheros)
			for (const c of campos(readFileSync(f, 'utf8')))
				if (c.atributos.get('type')?.valor === 'password' && !c.atributos.has('autocomplete'))
					sinDecir.push(`${relative(repo, f)}: ${texto(c.atributos.get('name')?.valor)}`);
		expect(sinDecir).toEqual([]);
	});
});
