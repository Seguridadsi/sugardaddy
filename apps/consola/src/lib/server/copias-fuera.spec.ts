/*
 * Las copias fuera de la máquina (copias-fuera.ts): lo que no necesita base de
 * datos. El formulario, la huella del destino, cuándo toca la prueba y los avisos.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('./db', () => ({ db: {}, schema: {} }));

const c = await import('./copias-fuera');

const S3 = {
	tipo: 's3',
	bucket: 'copias-banco',
	region: 'eu-west-1',
	claveId: 'AKIAEXAMPLE',
	secreto: 'secreta',
	conservar: '14'
};

function destino(extra: Partial<import('./copias-fuera').Destino> = {}) {
	return {
		version: 1,
		activo: true,
		tipo: 's3' as const,
		conservar: 14,
		inmutable: null,
		s3: {
			endpoint: '',
			region: 'eu-west-1',
			bucket: 'b',
			prefijo: '',
			estiloRuta: false,
			claveId: 'k'
		},
		secreto: 'v1.x.y.z.w',
		final: null,
		cambiado: '2026-11-01T00:00:00.000Z',
		quien: 'a@b',
		...extra
	};
}

describe('validar', () => {
	it('S3 de AWS y de MinIO', () => {
		const a = c.validar(S3, null);
		expect(a.ok && a.destino.s3).toMatchObject({ bucket: 'copias-banco', estiloRuta: false });
		const m = c.validar({ ...S3, endpoint: 'https://minio.local:9000/', prefijo: '/nodo/' }, null);
		expect(m.ok && m.destino.s3).toMatchObject({
			endpoint: 'https://minio.local:9000',
			estiloRuta: true,
			prefijo: 'nodo'
		});
	});

	it('rechaza lo que no vale', () => {
		expect(c.validar({ ...S3, endpoint: 'http://minio.local' }, null).ok).toBe(false);
		expect(c.validar({ ...S3, endpoint: 'https://minio.local/bucket' }, null).ok).toBe(false);
		expect(c.validar({ ...S3, bucket: 'Mayusculas' }, null).ok).toBe(false);
		expect(c.validar({ ...S3, secreto: '' }, null).ok).toBe(false);
		expect(c.validar({ ...S3, prefijo: 'a/../b' }, null).ok).toBe(false);
		expect(c.validar({ ...S3, conservar: '0' }, null).ok).toBe(false);
		expect(c.validar({ ...S3, inmutableDias: '9999' }, null).ok).toBe(false);
		expect(c.validar({ tipo: 'ftp' }, null).ok).toBe(false);
	});

	it('sin secreto vale si ya había uno del mismo tipo', () => {
		expect(c.validar({ ...S3, secreto: '' }, destino()).ok).toBe(true);
		expect(c.validar({ ...S3, tipo: 'smb', secreto: '' }, destino()).ok).toBe(false);
	});

	it('Azure: una SAS de contenedor con sus permisos; la URL sin la firma es lo que se ve', () => {
		const url = 'https://cuenta.blob.core.windows.net/copias?sv=2022-11-02&sp=racwdl&sig=abc%3D';
		const a = c.validar({ tipo: 'azure', secreto: url }, null);
		expect(a.ok && a.destino.azure).toEqual({
			contenedor: 'https://cuenta.blob.core.windows.net/copias',
			prefijo: ''
		});
		expect(c.validar({ tipo: 'azure', secreto: url.replace('racwdl', 'rl') }, null).ok).toBe(false);
		/* Para bloquear cada copia, la SAS necesita «i». */
		expect(c.validar({ tipo: 'azure', secreto: url, inmutableDias: '30' }, null).ok).toBe(false);
		expect(
			c.validar(
				{ tipo: 'azure', secreto: url.replace('racwdl', 'racwdli'), inmutableDias: '30' },
				null
			).ok
		).toBe(true);
		expect(
			c.validar(
				{ tipo: 'azure', secreto: 'https://cuenta.blob.core.windows.net/?sv=1&sig=a' },
				null
			).ok
		).toBe(false);
	});

	it('SMB: sin inmutabilidad, cifrado por defecto', () => {
		const f = {
			tipo: 'smb',
			servidor: '\\\\nas.local',
			recurso: 'Copias$',
			usuario: 'sd',
			secreto: 'a,b'
		};
		const a = c.validar(f, null);
		expect(a.ok && a.destino.smb).toMatchObject({ servidor: 'nas.local', cifrado: true });
		expect(c.validar({ ...f, inmutableDias: '5' }, null).ok).toBe(false);
		expect(c.validar({ ...f, recurso: 'a/b' }, null).ok).toBe(false);
	});
});

describe('dondeVa y la huella', () => {
	it('sin secretos', () => {
		expect(c.dondeVa(destino())).toBe('s3://b/');
		expect(
			c.dondeVa({
				tipo: 'smb',
				smb: {
					servidor: 'nas',
					recurso: 'C',
					carpeta: 'a/b',
					usuario: 'u',
					dominio: '',
					cifrado: true
				}
			})
		).toBe('\\\\nas\\C\\a\\b');
	});
	it('la huella cambia con el sitio o la credencial, no con cuántas se conservan', () => {
		const h = c.huellaDestino(destino());
		expect(c.huellaDestino(destino({ conservar: 3, activo: false }))).toBe(h);
		expect(c.huellaDestino(destino({ secreto: 'otro' }))).not.toBe(h);
	});
});

describe('la prueba de restauración', () => {
	const d = destino();
	const h = c.huellaDestino(d);
	const ahora = Date.parse('2026-11-15T00:00:00Z');
	const base = {
		informe: null,
		huella: h,
		local: null,
		ultimaSubida: { nombre: 'x', bytes: 1, sha256: 'a', cuando: '2026-11-14T03:00:00Z' },
		ultimoError: null,
		remotas: [],
		remotasCuando: null,
		bloqueadas: 0,
		avisos: [],
		prueba: null,
		conexion: null
	};
	it('toca la primera vez, cada 30 días, al día siguiente de un fallo o si se pide', () => {
		expect(c.pruebaToca(d, base, ahora)).toBe(true);
		const prueba = (resultado: 'ok' | 'fallo', cuando: string) => ({
			resultado,
			detalle: '',
			nombre: 'x',
			cuando,
			pedida: false
		});
		expect(c.pruebaToca(d, { ...base, prueba: prueba('ok', '2026-11-01T00:00:00Z') }, ahora)).toBe(
			false
		);
		expect(c.pruebaToca(d, { ...base, prueba: prueba('ok', '2026-10-15T00:00:00Z') }, ahora)).toBe(
			true
		);
		expect(
			c.pruebaToca(d, { ...base, prueba: prueba('fallo', '2026-11-13T00:00:00Z') }, ahora)
		).toBe(true);
		expect(c.pruebaToca(d, { ...base, ultimaSubida: null }, ahora)).toBe(false);
		expect(c.pruebaToca({ ...d, activo: false }, base, ahora)).toBe(false);
		expect(
			c.pruebaToca(
				{ ...d, pedidos: { prueba: { id: '1', cuando: '', quien: '' } } },
				{ ...base, ultimaSubida: null },
				ahora
			)
		).toBe(true);
	});
});

describe('avisos de salud', () => {
	const d = destino();
	const h = c.huellaDestino(d);
	const ahora = Date.parse('2026-11-15T12:00:00Z');
	const e = {
		informe: '2026-11-15T11:59:00Z',
		huella: h,
		local: {
			nombre: 'sugardaddy-20261115-031500.tar.age',
			bytes: 1,
			cuando: '2026-11-15T03:15:00Z'
		},
		ultimaSubida: { nombre: 'x', bytes: 1, sha256: 'a', cuando: '2026-11-15T03:16:00Z' },
		ultimoError: null,
		remotas: [],
		remotasCuando: null,
		bloqueadas: 0,
		avisos: [],
		prueba: null,
		conexion: null
	};
	const codigos = (p: ReturnType<typeof c.problemasCopias>) => p.map((x) => x.codigo);
	it('todo bien: nada', () => {
		expect(c.problemasCopias(d, e, ahora)).toEqual([]);
	});
	it('el destino falla', () => {
		const p = c.problemasCopias(
			d,
			{ ...e, ultimoError: { detalle: 's3: 403 AccessDenied', cuando: '', desde: '' } },
			ahora
		);
		expect(codigos(p)).toEqual(['salud.copias-sin-subir']);
		expect(p[0].texto).toContain('AccessDenied');
	});
	it('nada sube en 48 horas', () => {
		const p = c.problemasCopias(
			d,
			{ ...e, ultimaSubida: { ...e.ultimaSubida, cuando: '2026-11-12T03:00:00Z' } },
			ahora
		);
		expect(codigos(p)).toEqual(['salud.copias-sin-subir']);
	});
	it('la máquina no hace copias (también sin destino)', () => {
		const vieja = { ...e, local: { ...e.local, cuando: '2026-11-10T03:15:00Z' } };
		expect(codigos(c.problemasCopias(null, vieja, ahora))).toEqual(['salud.copias-sin-hacer']);
		/* Si el actualizador no cuenta nada, no se sabe: no se avisa. */
		expect(c.problemasCopias(null, { ...vieja, informe: null }, ahora)).toEqual([]);
	});
	it('la prueba de restauración falla', () => {
		const p = c.problemasCopias(
			d,
			{
				...e,
				prueba: {
					resultado: 'fallo',
					detalle: 'SHA-256 differs.',
					nombre: 'x',
					cuando: '',
					pedida: false
				}
			},
			ahora
		);
		expect(codigos(p)).toEqual(['salud.copias-prueba']);
	});
	it('lo de otro destino no cuenta', () => {
		const otro = { ...e, huella: 'otra', ultimoError: { detalle: 'x', cuando: '', desde: '' } };
		expect(codigos(c.problemasCopias(d, otro, ahora))).toEqual(['salud.copias-sin-subir']);
		expect(
			codigos(c.problemasCopias({ ...d, cambiado: '2026-11-15T00:00:00Z' }, otro, ahora))
		).toEqual([]);
	});
});
