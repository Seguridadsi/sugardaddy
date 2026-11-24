ALTER TABLE "cuarentena" ADD COLUMN "duplicado" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Lo que ya está en la cuarentena como repetido y es el mismo evento salvo su sitio en la
-- cadena (otro hashAnterior: el sensor volvió a leer la línea de su trampa) pasa a duplicado.
-- Nada se borra ni cambia de sitio: la fila, su línea, su hash y su hashAnterior se quedan,
-- y la cadena se sigue verificando igual. Solo deja de contar para el estado «degradado».
-- Un repetido con otro contenido sigue como estaba. La línea se lee como JSON sin fallar
-- nunca (una que no lo sea se queda como está), y el id solo si tiene forma de id.
CREATE OR REPLACE FUNCTION pg_temp.sd_jsonb(t text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
	RETURN t::jsonb;
EXCEPTION WHEN others THEN
	RETURN NULL;
END
$$;--> statement-breakpoint
WITH repetidos AS (
	SELECT q."id", q."sensor", pg_temp.sd_jsonb(q."linea") AS j
	FROM "cuarentena" q
	WHERE q."motivo" = 'repeats an event already received' AND q."linea" <> ''
), conid AS (
	SELECT r."id", r."sensor", r.j,
		CASE WHEN (r.j ->> 'id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
			THEN (r.j ->> 'id')::uuid END AS evento
	FROM repetidos r
	WHERE r.j IS NOT NULL
)
UPDATE "cuarentena" c
SET "duplicado" = true, "motivo" = 'repeats an event already received, only its place in the chain differs'
FROM conid x
JOIN "eventos" e ON e."id" = x.evento AND e."sensor" = x."sensor"
WHERE c."id" = x."id"
	AND (pg_temp.sd_jsonb(e."linea") - 'hashAnterior') = (x.j - 'hashAnterior');
