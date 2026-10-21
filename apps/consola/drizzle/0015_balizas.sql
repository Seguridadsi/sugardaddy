CREATE TABLE "balizas" (
	"token" text PRIMARY KEY NOT NULL,
	"trampa" text NOT NULL,
	"destino" text,
	"sensor" text NOT NULL,
	"receptor" text,
	"url" text NOT NULL,
	"fichero" text NOT NULL,
	"nombre" text NOT NULL,
	"tipo" text NOT NULL,
	"sha256" text NOT NULL,
	"nonce" text,
	"nonce_hasta" timestamp with time zone,
	"nonce_usado" timestamp with time zone,
	"creado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "balizas" ADD CONSTRAINT "balizas_trampa_trampas_id_fk" FOREIGN KEY ("trampa") REFERENCES "public"."trampas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balizas" ADD CONSTRAINT "balizas_destino_destinos_id_fk" FOREIGN KEY ("destino") REFERENCES "public"."destinos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balizas" ADD CONSTRAINT "balizas_sensor_sensores_id_fk" FOREIGN KEY ("sensor") REFERENCES "public"."sensores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balizas" ADD CONSTRAINT "balizas_receptor_trampas_id_fk" FOREIGN KEY ("receptor") REFERENCES "public"."trampas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "balizas_trampa" ON "balizas" USING btree ("trampa");--> statement-breakpoint
CREATE INDEX "balizas_sensor" ON "balizas" USING btree ("sensor");