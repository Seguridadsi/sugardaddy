/*
 * Para los formularios que enseñan un ajuste ya guardado (casillas, opciones):
 * `use:enhance={sinVaciar}`. Por defecto SvelteKit vacía el formulario al
 * guardar bien, y una casilla que ya estaba marcada se queda desmarcada en
 * pantalla aunque el valor guardado siga activo (Svelte no la vuelve a marcar
 * porque el dato no ha cambiado). Quien guardara otra vez la apagaría sin querer.
 */
import type { SubmitFunction } from '@sveltejs/kit';

export const sinVaciar: SubmitFunction =
	() =>
	({ update }) =>
		update({ reset: false });
