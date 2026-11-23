/*
 * El inventario de colocaciones (D7), lo puro: el id, la ruta exacta, los vencimientos de
 * caducidad y rotación y el formulario de la política. Lo que toca la base está en
 * colocaciones-base.spec.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));
vi.mock('./db', () => ({ db: {}, schema: {} }));

const { idColocacion, leerPolitica, ubicacionDe, vencimientos, versionPlantilla } =
	await import('./colocaciones');

const formulario = (campos: Record<string, string>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(campos)) f.set(k, v);
	return f;
};

describe('inventario de colocaciones: lo puro', () => {
	it('el id de una colocación es col- y 16 caracteres base32, distinto cada vez', () => {
		const ids = new Set(Array.from({ length: 200 }, idColocacion));
		expect(ids.size).toBe(200);
		for (const id of ids) expect(id).toMatch(/^col-[a-z2-7]{16}$/);
	});

	it('la versión de la plantilla es módulo@versión', () => {
		expect(versionPlantilla({ id: 'fichero-word', versionModulo: '0.2.0' })).toBe(
			'fichero-word@0.2.0'
		);
	});

	it('la ruta exacta junta la carpeta y el fichero con el separador que ya usa', () => {
		expect(ubicacionDe({ ruta: '\\\\fs01\\nominas' }, 'Nomina_ab12.docx')).toBe(
			'\\\\fs01\\nominas\\Nomina_ab12.docx'
		);
		expect(ubicacionDe({ ruta: 'C:\\Users\\Public\\' }, 'a.xlsx')).toBe(
			'C:\\Users\\Public\\a.xlsx'
		);
		expect(ubicacionDe({ ruta: '/srv/compartido/' }, 'a.pdf')).toBe('/srv/compartido/a.pdf');
		/* Una dirección de SharePoint lleva / aunque tenga \ en ningún sitio. */
		expect(
			ubicacionDe({ ruta: 'https://contoso.sharepoint.com/sites/F/Shared Documents/P' }, 'a.docx')
		).toBe('https://contoso.sharepoint.com/sites/F/Shared Documents/P/a.docx');
		/* Si la ruta ya acaba en el fichero, se queda; sin ruta, el nombre; sin nada, lo dice. */
		expect(ubicacionDe({ ruta: '/srv/a.pdf' }, 'a.pdf')).toBe('/srv/a.pdf');
		expect(ubicacionDe({}, 'a.pdf')).toBe('a.pdf');
		expect(ubicacionDe({ ruta: '  ' })).toBe('(not recorded)');
	});

	it('caduca cuando pasa la fecha y la rotación vence a los N días de sembrarla', () => {
		const ahora = new Date('2026-11-19T12:00:00Z');
		const sembrada = new Date('2026-11-09T12:00:00Z');
		const sin = vencimientos(
			{ estado: 'colocada', sembrada },
			{ caduca: null, rotarDias: null },
			ahora
		);
		expect(sin).toEqual({ caducada: false, rotarEl: null, rotacionVencida: false });
		const v = vencimientos(
			{ estado: 'colocada', sembrada },
			{ caduca: new Date('2026-11-19T11:59:59Z'), rotarDias: 10 },
			ahora
		);
		expect(v.caducada).toBe(true);
		expect(v.rotarEl?.toISOString()).toBe('2026-11-19T12:00:00.000Z');
		expect(v.rotacionVencida).toBe(true);
		expect(
			vencimientos({ estado: 'colocada', sembrada }, { caduca: null, rotarDias: 11 }, ahora)
				.rotacionVencida
		).toBe(false);
		/* Lo que no está puesto (pendiente, retirado, sustituido) no caduca ni rota. */
		for (const estado of ['pendiente', 'retirada', 'sustituida', 'retirando'])
			expect(
				vencimientos(
					{ estado, sembrada },
					{ caduca: new Date('2000-01-01T00:00:00Z'), rotarDias: 1 },
					ahora
				)
			).toEqual({ caducada: false, rotarEl: null, rotacionVencida: false });
	});

	it('la política: fecha futura AAAA-MM-DD (final del día, UTC) y de 1 a 3650 días; vacío = nada', () => {
		const ahora = new Date('2026-11-19T12:00:00Z');
		expect(leerPolitica(formulario({ caduca: '', rotarDias: '' }), ahora)).toEqual({
			ok: true,
			caduca: null,
			rotarDias: null
		});
		const p = leerPolitica(formulario({ caduca: '2027-01-31', rotarDias: '90' }), ahora);
		expect(p.ok && p.caduca?.toISOString()).toBe('2027-01-31T23:59:59.000Z');
		expect(p.ok && p.rotarDias).toBe(90);
		for (const [caduca, rotarDias, error] of [
			['31/01/2027', '', /YYYY-MM-DD/],
			['2027-02-30', '', /does not exist/],
			['2026-11-18', '', /future/],
			['', '0', /between 1 and 3650/],
			['', '3651', /between 1 and 3650/],
			['', '7.5', /between 1 and 3650/]
		] as const) {
			const r = leerPolitica(formulario({ caduca, rotarDias }), ahora);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toMatch(error);
		}
	});
});
