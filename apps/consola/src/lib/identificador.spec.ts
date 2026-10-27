import { describe, expect, it } from 'vitest';
import { identificador } from './identificador';

describe('el identificador que se escribe al dar de alta', () => {
	it('se guarda en minúsculas, sin tildes y con guiones', () => {
		expect(identificador('Trampa DNS', '')).toBe('trampa-dns');
		expect(identificador('DNS_01', '')).toBe('dns-01');
		expect(identificador('  Nóminas (Sevilla) ', '')).toBe('nominas-sevilla');
		expect(identificador('-dns.ntp-', '')).toBe('dns-ntp');
		expect(identificador('dns-01', '')).toBe('dns-01');
	});

	it('sin nada aprovechable, sale del nombre visible', () => {
		expect(identificador('', 'Servidor de nombres 2')).toBe('servidor-de-nombres-2');
		expect(identificador('¿?', 'ns2')).toBe('ns2');
	});

	it('vacío si ni uno ni otro tienen una letra o un número', () => {
		expect(identificador('', '')).toBe('');
		expect(identificador('---', '***')).toBe('');
	});

	it('63 caracteres como mucho, sin guion al final', () => {
		const id = identificador(`${'a'.repeat(62)} b`, '');
		expect(id).toBe('a'.repeat(62));
		expect(identificador('x'.repeat(80), '')).toHaveLength(63);
	});
});
