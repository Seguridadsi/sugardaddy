-- Los sensores que ya existían siguen registrando lo de su propia máquina. Con la 0.24.2 todos
-- quedaron sin registrarlo al actualizar, y un reenviador en la máquina (nginx, socat, un
-- túnel) hace que todo lo que llega por él parezca de la máquina: nadie debe perder eventos
-- sin enterarse por actualizar. Solo los que nadie ha tocado: si alguien ya marcó o desmarcó
-- la casilla, se queda como la dejó. Los sensores nuevos siguen naciendo sin registrarlo.
UPDATE "sensores" SET "registrar_propio" = true
WHERE NOT EXISTS (
	SELECT 1 FROM "auditoria"
	WHERE "auditoria"."accion" IN ('sensor own-machine recording enabled', 'sensor own-machine recording disabled')
		AND "auditoria"."detalle"->>'id' = "sensores"."id"
);
