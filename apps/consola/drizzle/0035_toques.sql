CREATE TABLE "toques" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prueba" uuid NOT NULL,
	"sensor" text NOT NULL,
	"trampa" text NOT NULL,
	"direccion" text NOT NULL,
	"puerto" integer NOT NULL,
	"codigo" text NOT NULL,
	"ips" text[] NOT NULL,
	"pedido" timestamp with time zone DEFAULT now() NOT NULL,
	"entregado" timestamp with time zone,
	"ok" boolean,
	"detalle" text
);
--> statement-breakpoint
ALTER TABLE "toques" ADD CONSTRAINT "toques_prueba_pruebas_id_fk" FOREIGN KEY ("prueba") REFERENCES "public"."pruebas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "toques" ADD CONSTRAINT "toques_sensor_sensores_id_fk" FOREIGN KEY ("sensor") REFERENCES "public"."sensores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "toques_pendientes" ON "toques" USING btree ("sensor") WHERE "toques"."entregado" IS NULL;