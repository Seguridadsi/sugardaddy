/*
 * Recuperación de acceso por la MÁQUINA del nodo (login local), para cuando
 * nadie puede entrar en la consola y no hay (o no sirve) una llave de emergencia
 * FIDO2. Solo lo puede ejecutar quien tiene acceso al servidor y a su base de
 * datos: ese acceso ES la autorización, igual que scripts/emergencia.mjs.
 *
 *   docker compose exec consola node scripts/clave.mjs listar
 *   docker compose exec consola node scripts/clave.mjs reset <usuario>
 *   docker compose exec consola node scripts/clave.mjs crear-admin <usuario> [nombre] [correo]
 *
 * reset y crear-admin imprimen una contraseña de UN SOLO USO (aquí y solo aquí);
 * la consola obliga a cambiarla al entrar. No tocan los roles de nadie, así que
 * no pueden dejar el nodo sin administradores; crear-admin es justo para el caso
 * de que no quede ninguno. Todo queda en la auditoría como «máquina del nodo».
 */
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import postgres from 'postgres';

/* Mismo formato que src/lib/server/auth/local.ts y scripts/preparar-base.mjs
 * (scrypt$N$r$p$sal$hash). Si cambia allí, cámbialo aquí: lo fija una prueba. */
function hashClaveLocal(clave) {
	const N = 1 << 15;
	const sal = randomBytes(16);
	const h = scryptSync(clave, sal, 32, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
	return `scrypt$${N}$8$1$${sal.toString('base64')}$${h.toString('base64')}`;
}

/* Mismas reglas que local.ts: minúsculas, 3-32, empieza/acaba en letra o número. */
const norma = (u) =>
	String(u ?? '')
		.trim()
		.toLowerCase();
const usuarioValido = (u) => /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/.test(norma(u));

function salir(mensaje, codigo = 1) {
	console.error(mensaje);
	process.exitCode = codigo;
}

function imprimirClave(usuario, clave) {
	const barra = '='.repeat(60);
	console.log(
		`\n${barra}\n  ACCESO RESTABLECIDO (login local)\n` +
			`  Usuario:     ${usuario}\n  Contraseña:  ${clave}\n` +
			`  De un solo uso: la consola te la hará cambiar al entrar.\n${barra}\n`
	);
}

const [orden, arg2, arg3, arg4] = process.argv.slice(2);
const USO =
	'Uso:\n' +
	'  node scripts/clave.mjs listar\n' +
	'  node scripts/clave.mjs reset <usuario>\n' +
	'  node scripts/clave.mjs crear-admin <usuario> [nombre] [correo]';

if (!process.env.DATABASE_URL) {
	salir('Falta DATABASE_URL en el entorno.');
} else if (!['listar', 'reset', 'crear-admin'].includes(orden)) {
	salir(USO);
} else {
	const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
	try {
		if (orden === 'listar') {
			const filas = await sql`select usuario, nombre, roles, debe_cambiar, bloqueado_hasta,
				ultimo_acceso from usuarios_locales order by usuario`;
			if (filas.length === 0) {
				console.log(
					'No hay usuarios locales. Crea un admin: node scripts/clave.mjs crear-admin <usuario>'
				);
			} else {
				for (const f of filas) {
					/* postgres-js devuelve el jsonb `roles` como string JSON, no como array. */
					const roles = Array.isArray(f.roles) ? f.roles : JSON.parse(f.roles);
					const bloq =
						f.bloqueado_hasta && new Date(f.bloqueado_hasta) > new Date() ? ' [BLOQUEADO]' : '';
					const cambia = f.debe_cambiar ? ' [debe cambiar la clave]' : '';
					console.log(`  ${f.usuario}  (${f.nombre})  roles: ${roles.join(', ')}${bloq}${cambia}`);
				}
			}
		} else if (orden === 'reset') {
			const usuario = norma(arg2);
			if (!usuario) {
				salir('Falta el usuario. ' + USO);
			} else {
				const clave = randomBytes(12).toString('base64url');
				const filas = await sql`update usuarios_locales
					set clave_hash = ${hashClaveLocal(clave)}, debe_cambiar = true,
						intentos_fallidos = 0, bloqueado_hasta = null
					where usuario = ${usuario} returning usuario`;
				if (filas.length === 0) {
					salir(
						`No hay ningún usuario local «${usuario}». Mira los que hay: node scripts/clave.mjs listar`
					);
				} else {
					await sql`insert into auditoria (quien, accion, detalle)
						values ('máquina del nodo', 'contraseña local restablecida desde la máquina', ${JSON.stringify({ usuario })}::jsonb)`;
					imprimirClave(usuario, clave);
				}
			}
		} else if (orden === 'crear-admin') {
			const usuario = norma(arg2);
			if (!usuarioValido(usuario)) {
				salir(
					'El usuario lleva de 3 a 32 caracteres: letras, números, punto, guion o guion bajo, y empieza/acaba en letra o número.'
				);
			} else {
				const [existe] = await sql`select 1 from usuarios_locales where usuario = ${usuario}`;
				if (existe) {
					salir(
						`Ya hay un usuario «${usuario}». Para darle una clave nueva: node scripts/clave.mjs reset ${usuario}`
					);
				} else {
					const clave = randomBytes(12).toString('base64url');
					await sql`insert into usuarios_locales (id, usuario, nombre, correo, clave_hash, roles, debe_cambiar, creada_por)
						values (${randomUUID()}, ${usuario}, ${arg3?.trim() || 'Administrador'}, ${arg4?.trim() || `${usuario}@local`},
							${hashClaveLocal(clave)}, ${JSON.stringify(['admin'])}::jsonb, true, 'máquina del nodo')`;
					await sql`insert into auditoria (quien, accion, detalle)
						values ('máquina del nodo', 'administrador local creado desde la máquina', ${JSON.stringify({ usuario })}::jsonb)`;
					imprimirClave(usuario, clave);
				}
			}
		}
	} finally {
		await sql.end();
	}
}
