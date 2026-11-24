CREATE TABLE "salud_muestras" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sensor" text NOT NULL,
	"cuando" timestamp with time zone NOT NULL,
	"cpu" real,
	"carga1" real,
	"cpus" smallint,
	"memoria_total" bigint,
	"memoria_libre" bigint,
	"disco_total" bigint,
	"disco_libre" bigint,
	"trampas" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "salud_muestras" ADD CONSTRAINT "salud_muestras_sensor_sensores_id_fk" FOREIGN KEY ("sensor") REFERENCES "public"."sensores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "salud_muestras_sensor_cuando" ON "salud_muestras" USING btree ("sensor","cuando");