-- Los sensores quitados antes de la 0.29 se quedaron con el token cortado pero sin marcar
-- como retirados: seguían en Sensors como si nada y su identificador no se podía volver a
-- dar de alta. Se marcan con la fecha de su retirada (la auditoría la guarda un año), salvo
-- que hayan latido después: entonces alguien los volvió a instalar y siguen en uso.
UPDATE "sensores" s
SET "retirado" = a.cuando
FROM (
	SELECT "detalle"->>'id' AS id, max("cuando") AS cuando
	FROM "auditoria"
	WHERE "accion" = 'sensor deactivated'
	GROUP BY 1
) a
WHERE s."id" = a.id
	AND s."retirado" IS NULL
	AND s."remoto" = true
	AND (s."ultimo_latido" IS NULL OR s."ultimo_latido" <= a.cuando + interval '5 minutes');
