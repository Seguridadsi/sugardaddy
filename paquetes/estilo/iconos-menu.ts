/*
 * Los iconos del menú lateral, los mismos en la consola y en el panel central.
 * Cada uno es una lista de trazos sobre una rejilla de 24×24, para pintarlos
 * con el color del texto sin inyectar HTML en la página. Dibujo propio.
 */

/* Una circunferencia como trazo: así un icono es solo una lista de `d`. */
const circulo = (x: number, y: number, r: number) =>
	`M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

export const ICONOS_MENU = {
	resumen: ['M4 20V11', 'M10 20V5', 'M16 20v-6', 'M21 20H3'],
	mapa: [
		circulo(12, 5, 2),
		circulo(5, 19, 2),
		circulo(19, 19, 2),
		'M11 6.8 6 17.2',
		'M13 6.8l5 10.4',
		'M7 19h10'
	],
	eventos: ['M3 12h4l3 8 4-16 3 8h4'],
	incidentes: ['M12 3.5 2.5 20h19L12 3.5Z', 'M12 10v4', 'M12 17h.01'],
	contrasenas: [circulo(8, 16, 4), 'M11 13l9-9', 'M16 8l3 3', 'M13.5 10.5l2 2'],
	trampas: [
		'M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5L12 2.5Z',
		'M12 8.5l3 1.75v3.5l-3 1.75-3-1.75v-3.5l3-1.75Z'
	],
	sensores: [
		'M4 4.5h16v6H4z',
		'M4 13.5h16v6H4z',
		'M8 7.5h.01',
		'M8 16.5h.01',
		'M12 7.5h4',
		'M12 16.5h4'
	],
	respuestas: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Z', 'M9 12l2 2 4-4'],
	listas: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3.5 6h.01', 'M3.5 12h.01', 'M3.5 18h.01'],
	origenes: [circulo(12, 12, 9), 'M3 12h18', 'M12 3c3.2 3 3.2 15 0 18-3.2-3-3.2-15 0-18Z'],
	avisos: ['M6 9.5a6 6 0 1 1 12 0c0 5.5 2.5 7.5 2.5 7.5h-17S6 15 6 9.5Z', 'M10 20.5a2 2 0 0 0 4 0'],
	informes: ['M6 3h8l5 5v13H6V3Z', 'M14 3v5h5', 'M9 13h7', 'M9 17h7'],
	usuarios: [
		circulo(9, 8, 3.5),
		'M2.5 20.5c0-4 3-6.5 6.5-6.5s6.5 2.5 6.5 6.5',
		'M16 4.8a3.5 3.5 0 0 1 0 6.4',
		'M18 14.5c2.2.8 3.5 3 3.5 6'
	],
	licencia: [circulo(12, 9, 6), 'M8.5 14 7 21.5l5-2.5 5 2.5-1.5-7.5', 'M10 9l1.5 1.5L14.5 7.5'],
	logs: ['M9 3.5h6v3H9z', 'M7 5H5v16h14V5h-2', 'M9 11.5h6', 'M9 15.5h6'],
	ajustes: ['M4 7h9', 'M19 7h1', 'M4 17h1', 'M11 17h9', circulo(16, 7, 2.5), circulo(8, 17, 2.5)],
	cuenta: [circulo(12, 8, 4), 'M4.5 21c0-4.2 3.3-6.8 7.5-6.8s7.5 2.6 7.5 6.8'],
	salir: ['M10 4H5v16h5', 'M15 8l4 4-4 4', 'M19 12H9'],
	menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
	cerrar: ['M6 6l12 12', 'M18 6 6 18'],
	clientes: [
		'M4 21V5l8-2v18',
		'M12 9l8 2v10',
		'M2.5 21h19',
		'M8 8h.01',
		'M8 12h.01',
		'M8 16h.01',
		'M16 14h.01',
		'M16 17.5h.01'
	],
	versiones: [
		'M12 2.5l8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5L12 2.5Z',
		'M3.5 7.25 12 12l8.5-4.75',
		'M12 12v9.5'
	],
	inteligencia: [
		'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z',
		circulo(12, 12, 3)
	],
	catalogo: [
		'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15Z',
		'M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3'
	],
	correo: ['M3 5.5h18v13H3z', 'M3 7l9 6.5L21 7'],
	socios: [
		circulo(8, 8, 3),
		circulo(16, 8, 3),
		'M2.5 19c0-3.2 2.4-5 5.5-5s5.5 1.8 5.5 5',
		'M15 14.1c3.4-.4 6.5 1.4 6.5 4.9'
	],
	comunicados: ['M4 10v4l2 .5 1.5 5H10l-1.2-4.2L19 18V6L6 9.5 4 10Z', 'M22 12h-3'],
	escalados: ['M12 20V5', 'M6 11l6-6 6 6', 'M5 21h14']
} as const;

export type IconoMenu = keyof typeof ICONOS_MENU;
