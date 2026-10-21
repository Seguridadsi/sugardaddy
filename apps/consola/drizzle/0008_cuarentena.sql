CREATE TABLE "cuarentena" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sensor" text NOT NULL,
	"hash" text NOT NULL,
	"hash_anterior" text,
	"linea" text NOT NULL,
	"motivo" text NOT NULL,
	"recibido" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rupturas" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sensor" text NOT NULL,
	"esperado" text NOT NULL,
	"recibido" text NOT NULL,
	"hash" text NOT NULL,
	"cuando" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cuarentena" ADD CONSTRAINT "cuarentena_sensor_sensores_id_fk" FOREIGN KEY ("sensor") REFERENCES "public"."sensores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rupturas" ADD CONSTRAINT "rupturas_sensor_sensores_id_fk" FOREIGN KEY ("sensor") REFERENCES "public"."sensores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cuarentena_hash" ON "cuarentena" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "cuarentena_sensor" ON "cuarentena" USING btree ("sensor");