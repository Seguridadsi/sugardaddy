CREATE TABLE "auditoria_cabeza" (
	"id" smallint PRIMARY KEY NOT NULL,
	"ultimo" bigint DEFAULT 0 NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auditoria_sellos" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"cuando" timestamp with time zone DEFAULT now() NOT NULL,
	"hasta" bigint NOT NULL,
	"hash" text NOT NULL,
	"algoritmo" text NOT NULL,
	"clave" text,
	"firma" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auditoria" ADD COLUMN "hash_anterior" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "auditoria" ADD COLUMN "hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Auditoría inmutable (docs/diseno/auditoria-inmutable.md). Lo de abajo no lo genera
-- drizzle-kit: la cadena de hash la pone la base, no la aplicación, para que cualquier
-- INSERT (de esta consola, de una anterior tras volver atrás o de un script de la
-- máquina) entre encadenado.
--
-- La fila canónica: jsonb_build_array(id, cuando en UTC con microsegundos, quien,
-- accion, detalle)::text. jsonb ya ordena sus claves, así que el mismo contenido da
-- siempre el mismo texto. hash = SHA-256(hash_anterior || canónica), en hex.
CREATE FUNCTION auditoria_canonica(p_id bigint, p_cuando timestamptz, p_quien text, p_accion text, p_detalle jsonb)
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
	SELECT jsonb_build_array(
		p_id,
		to_char(p_cuando AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		p_quien,
		p_accion,
		p_detalle
	)::text
$$;
--> statement-breakpoint
CREATE FUNCTION auditoria_hash(p_anterior text, p_canonica text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
	SELECT encode(sha256(convert_to(p_anterior || p_canonica, 'UTF8')), 'hex')
$$;
--> statement-breakpoint
-- Las filas que ya había se encadenan en orden de id, desde el génesis (64 ceros).
DO $$
DECLARE
	f record;
	anterior text := repeat('0', 64);
	ultimo bigint := 0;
BEGIN
	FOR f IN SELECT id, cuando, quien, accion, detalle FROM auditoria ORDER BY id LOOP
		UPDATE auditoria
			SET hash_anterior = anterior,
				hash = auditoria_hash(anterior, auditoria_canonica(f.id, f.cuando, f.quien, f.accion, f.detalle))
			WHERE id = f.id
			RETURNING hash INTO anterior;
		ultimo := f.id;
	END LOOP;
	INSERT INTO auditoria_cabeza (id, ultimo, hash) VALUES (1, ultimo, anterior);
END $$;
--> statement-breakpoint
-- Al insertar (con el rol sugardaddy_auditoria, más abajo): se bloquea la cabeza (las inserciones se encadenan de una en una), el id
-- se toma ya con ella bloqueada (así el orden de los id es el de la cadena) y se calcula
-- el hash. Lo que mande quien inserta en id, hash_anterior y hash no cuenta.
CREATE FUNCTION auditoria_encadenar() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	c record;
BEGIN
	SELECT ultimo, hash INTO c FROM auditoria_cabeza WHERE id = 1 FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'auditoria: the chain head is missing';
	END IF;
	NEW.id := nextval(pg_get_serial_sequence('auditoria', 'id'));
	NEW.cuando := coalesce(NEW.cuando, now());
	NEW.detalle := coalesce(NEW.detalle, '{}'::jsonb);
	NEW.hash_anterior := c.hash;
	NEW.hash := auditoria_hash(c.hash, auditoria_canonica(NEW.id, NEW.cuando, NEW.quien, NEW.accion, NEW.detalle));
	UPDATE auditoria_cabeza SET ultimo = NEW.id, hash = NEW.hash WHERE id = 1;
	RETURN NEW;
END $$;
--> statement-breakpoint
-- Sin valor por defecto: el id lo pone siempre el trigger (la secuencia sigue siendo de
-- la columna). Si no, cada fila gastaría dos números.
ALTER TABLE auditoria ALTER COLUMN id DROP DEFAULT;
--> statement-breakpoint
CREATE TRIGGER auditoria_encadenar BEFORE INSERT ON auditoria
	FOR EACH ROW EXECUTE FUNCTION auditoria_encadenar();
--> statement-breakpoint
-- Nada se cambia ni se borra, salvo la purga por plazo: auditoria_purgar, que corre
-- con el rol sugardaddy_auditoria (SECURITY DEFINER). Ni el dueño de la tabla puede: el
-- trigger salta para todos. Un superusuario puede apagar triggers; para eso está el
-- sellado de cada hora, que ya salió de la máquina.
CREATE FUNCTION auditoria_solo_crece() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' AND current_user = 'sugardaddy_auditoria' THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'auditoria: % on % is not allowed (the audit log only grows)', TG_OP, TG_TABLE_NAME
		USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER auditoria_solo_crece BEFORE UPDATE OR DELETE ON auditoria
	FOR EACH ROW EXECUTE FUNCTION auditoria_solo_crece();
--> statement-breakpoint
CREATE TRIGGER auditoria_sin_truncate BEFORE TRUNCATE ON auditoria
	FOR EACH STATEMENT EXECUTE FUNCTION auditoria_solo_crece();
--> statement-breakpoint
CREATE TRIGGER auditoria_sellos_solo_crece BEFORE UPDATE OR DELETE ON auditoria_sellos
	FOR EACH ROW EXECUTE FUNCTION auditoria_solo_crece();
--> statement-breakpoint
CREATE TRIGGER auditoria_sellos_sin_truncate BEFORE TRUNCATE ON auditoria_sellos
	FOR EACH STATEMENT EXECUTE FUNCTION auditoria_solo_crece();
--> statement-breakpoint
-- El rol de la auditoría: sin login, solo existe para ser dueño de auditoria_encadenar
-- (escribe la cabeza, que la aplicación no puede tocar) y de auditoria_purgar.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sugardaddy_auditoria') THEN
		CREATE ROLE sugardaddy_auditoria NOLOGIN;
	END IF;
END $$;
--> statement-breakpoint
-- La purga: el prefijo de la cadena hasta la última fila antes de la primera que no ha
-- caducado (una fila con fecha falsa del pasado no arrastra a las de después), y deja
-- «audit log purged» con hasta qué id y el hash de la última borrada: la primera que
-- queda cuelga de él.
CREATE FUNCTION auditoria_purgar(p_antes timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	n bigint;
	h text;
	filas integer;
BEGIN
	SELECT min(id) - 1 INTO n FROM auditoria WHERE cuando >= p_antes;
	IF n IS NULL THEN
		SELECT max(id) INTO n FROM auditoria;
	END IF;
	IF n IS NULL THEN
		RETURN 0;
	END IF;
	SELECT hash INTO h FROM auditoria WHERE id <= n ORDER BY id DESC LIMIT 1;
	IF h IS NULL THEN
		RETURN 0;
	END IF;
	DELETE FROM auditoria WHERE id <= n;
	GET DIAGNOSTICS filas = ROW_COUNT;
	DELETE FROM auditoria_sellos WHERE hasta <= n;
	INSERT INTO auditoria (quien, accion, detalle)
		VALUES ('retention', 'audit log purged',
			jsonb_build_object('hasta', n, 'hash', h, 'filas', filas, 'antesDe', p_antes));
	RETURN filas;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON auditoria TO sugardaddy_auditoria;
--> statement-breakpoint
GRANT SELECT, DELETE ON auditoria_sellos TO sugardaddy_auditoria;
--> statement-breakpoint
GRANT SELECT, UPDATE ON auditoria_cabeza TO sugardaddy_auditoria;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE auditoria_id_seq TO sugardaddy_auditoria;
--> statement-breakpoint
ALTER FUNCTION auditoria_purgar(timestamptz) OWNER TO sugardaddy_auditoria;
--> statement-breakpoint
ALTER FUNCTION auditoria_encadenar() OWNER TO sugardaddy_auditoria;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auditoria_purgar(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auditoria_purgar(timestamptz) TO CURRENT_USER;
--> statement-breakpoint
-- El rol de la aplicación (el que migra) se queda sin UPDATE, DELETE ni TRUNCATE.
REVOKE UPDATE, DELETE, TRUNCATE ON auditoria, auditoria_sellos FROM PUBLIC, CURRENT_USER;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON auditoria_cabeza FROM PUBLIC, CURRENT_USER;
