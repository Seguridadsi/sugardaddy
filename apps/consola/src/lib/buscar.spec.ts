import { describe, expect, it } from 'vitest';
import { casa, llano } from './buscar';

describe('el buscador de las listas', () => {
	it('sin acentos, sin mayúsculas y sin distinguir guiones de espacios', () => {
		expect(llano('Órdenes_de-Compra.XLSX')).toBe('ordenes de compra xlsx');
		expect(casa('inet-ssh cowrie sensor-1 10.50.0.4:22', 'Sensor 1')).toBe(true);
		expect(casa('srv-backup01 cowrie Servidores', 'srv backup')).toBe(true);
		expect(casa('Recurso NOMINAS$ samba', 'nóminas')).toBe(true);
	});

	it('tienen que estar todas las palabras, en cualquier orden', () => {
		expect(casa('inet-rdp rdp sensor-1', 'sensor rdp')).toBe(true);
		expect(casa('inet-rdp rdp sensor-1', 'sensor mysql')).toBe(false);
	});

	it('sin nada que buscar, todo casa', () => {
		expect(casa('lo que sea', '   ')).toBe(true);
	});
});
