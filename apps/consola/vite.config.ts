import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			/*
			 * Esta consola pinta texto que escribe el atacante (usuarios, comandos,
			 * URLs). Svelte lo escapa, nunca se usa {@html}, y si aun así se colara
			 * un script, la política no lo deja ejecutarse ni llamar a ningún sitio.
			 */
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['none'],
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline', 'https://fonts.googleapis.com'],
					'font-src': ['self', 'https://fonts.gstatic.com'],
					'img-src': ['self', 'data:'],
					'connect-src': ['self'],
					/* Salir acaba en Microsoft para cerrar también allí, y form-action se aplica a toda la cadena de redirecciones. */
					'form-action': ['self', 'https://login.microsoftonline.com'],
					'frame-ancestors': ['none'],
					'base-uri': ['none'],
					'object-src': ['none']
				}
			}
		})
	],
	test: {
		expect: { requireAssertions: true },
		include: ['src/**/*.spec.ts'],
		environment: 'node'
	}
});
