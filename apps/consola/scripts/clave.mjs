/*
 * Recuperación de acceso por la MÁQUINA del nodo (login local), para cuando
 * nadie puede entrar en la consola y no hay (o no sirve) una llave de emergencia
 * FIDO2. Solo lo puede ejecutar quien tiene acceso al servidor y a su base de
 * datos: ese acceso ES la autorización, igual que scripts/emergencia.mjs.
 *
 *   sudo docker compose --env-file .env --env-file versiones.env exec consola node scripts/clave.mjs listar
 *   sudo docker compose --env-file .env --env-file versiones.env exec consola node scripts/clave.mjs reset <usuario>
 *   sudo docker compose --env-file .env --env-file versiones.env exec consola node scripts/clave.mjs crear-admin <usuario> [nombre] [correo]
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
		`\n${barra}\n  ACCESS RESTORED (local sign-in)\n` +
			`  Username:    ${usuario}\n  Password:  ${clave}\n` +
			`  Single use: the console will ask you to change it when you sign in.\n${barra}\n`
	);
}

const [orden, arg2, arg3, arg4] = process.argv.slice(2);
const USO =
	'Usage:\n' +
	'  node scripts/clave.mjs listar\n' +
	'  node scripts/clave.mjs reset <username>\n' +
	'  node scripts/clave.mjs crear-admin <username> [name] [email]';

if (!process.env.DATABASE_URL) {
	salir('DATABASE_URL is missing from the environment.');
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
					'There are no local users. Create an admin: node scripts/clave.mjs crear-admin <username>'
				);
			} else {
				for (const f of filas) {
					/* postgres-js devuelve el jsonb `roles` como string JSON, no como array. */
					const roles = Array.isArray(f.roles) ? f.roles : JSON.parse(f.roles);
					const bloq =
						f.bloqueado_hasta && new Date(f.bloqueado_hasta) > new Date() ? ' [LOCKED]' : '';
					const cambia = f.debe_cambiar ? ' [must change password]' : '';
					console.log(`  ${f.usuario}  (${f.nombre})  roles: ${roles.join(', ')}${bloq}${cambia}`);
				}
			}
		} else if (orden === 'reset') {
			const usuario = norma(arg2);
			if (!usuario) {
				salir('The username is missing. ' + USO);
			} else {
				const clave = randomBytes(12).toString('base64url');
				const filas = await sql`update usuarios_locales
					set clave_hash = ${hashClaveLocal(clave)}, debe_cambiar = true,
						intentos_fallidos = 0, bloqueado_hasta = null
					where usuario = ${usuario} returning usuario`;
				if (filas.length === 0) {
					salir(
						`There is no local user "${usuario}". See which ones exist: node scripts/clave.mjs listar`
					);
				} else {
					await sql`insert into auditoria (quien, accion, detalle)
						values ('node machine', 'local password reset from the machine', ${JSON.stringify({ usuario })}::text::jsonb)`;
					imprimirClave(usuario, clave);
				}
			}
		} else if (orden === 'crear-admin') {
			const usuario = norma(arg2);
			if (!usuarioValido(usuario)) {
				salir(
					'A username has 3 to 32 characters: letters, digits, dot, hyphen or underscore, and starts and ends with a letter or digit.'
				);
			} else {
				const [existe] = await sql`select 1 from usuarios_locales where usuario = ${usuario}`;
				if (existe) {
					salir(
						`User "${usuario}" already exists. To give it a new password: node scripts/clave.mjs reset ${usuario}`
					);
				} else {
					const clave = randomBytes(12).toString('base64url');
					await sql`insert into usuarios_locales (id, usuario, nombre, correo, clave_hash, roles, debe_cambiar, creada_por)
						values (${randomUUID()}, ${usuario}, ${arg3?.trim() || 'Administrator'}, ${arg4?.trim() || `${usuario}@local`},
							${hashClaveLocal(clave)}, ${JSON.stringify(['admin'])}::text::jsonb, true, 'node machine')`;
					await sql`insert into auditoria (quien, accion, detalle)
						values ('node machine', 'local administrator created from the machine', ${JSON.stringify({ usuario })}::text::jsonb)`;
					imprimirClave(usuario, clave);
				}
			}
		}
	} finally {
		await sql.end();
	}
}
