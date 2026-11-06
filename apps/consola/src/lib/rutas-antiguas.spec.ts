import { describe, expect, it } from 'vitest';
import { rutaNueva } from './rutas-antiguas';

describe('rutaNueva', () => {
	it('lleva las rutas de antes a las de ahora', () => {
		expect(rutaNueva('/trampas')).toBe('/decoys');
		expect(rutaNueva('/trampas/ssh-1')).toBe('/decoys/ssh-1');
		expect(rutaNueva('/trampas/ssh-1/pasos/ps1')).toBe('/decoys/ssh-1/steps/ps1');
		expect(rutaNueva('/trampas/catalogo/cowrie')).toBe('/decoys/catalog/cowrie');
		expect(rutaNueva('/eventos/abc/sesion')).toBe('/events/abc/session');
		expect(rutaNueva('/eventos/ip/10.0.0.1')).toBe('/events/ip/10.0.0.1');
		expect(rutaNueva('/aviso/enlace123')).toBe('/alert/enlace123');
		expect(rutaNueva('/informe')).toBe('/reports/monthly');
		expect(rutaNueva('/avisos/informe-correo')).toBe('/reports/email');
		expect(rutaNueva('/respuestas/bloquear-ip/preparar.sh')).toBe(
			'/responses/bloquear-ip/prepare.sh'
		);
		expect(rutaNueva('/entrar/')).toBe('/sign-in');
	});

	it('no toca lo que ya es de ahora ni lo que usan las máquinas', () => {
		for (const r of [
			'/',
			'/decoys',
			'/events/abc',
			'/api/sensor/eventos',
			'/auth/login',
			'/instalar-sensor/abc',
			'/ca-raiz.crt',
			'/marca/logo',
			'/logs'
		])
			expect(rutaNueva(r)).toBeNull();
	});
});
