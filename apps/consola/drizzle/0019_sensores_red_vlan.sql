ALTER TABLE "sensores" ALTER COLUMN "segmento" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sensores" ADD COLUMN "red" text;--> statement-breakpoint
ALTER TABLE "sensores" ADD COLUMN "vlan" integer;--> statement-breakpoint
-- Relleno (escrito a mano): el segmento que ya era una red IPv4 en CIDR pasa a
-- «red», con la dirección de la red (10.70.0.5/24 → 10.70.0.0/24). El resto,
-- como «el de este nodo» del sensor local, queda sin red: la pone el
-- instalador o se indica en Sensores. «segmento» se queda para la consola
-- anterior, por si el nodo vuelve atrás.
UPDATE "sensores" SET "red" = network("segmento"::inet)::text
	WHERE "segmento" ~ '^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])/(3[0-2]|[12]?[0-9])$'
		AND masklen("segmento"::inet) >= 8;
