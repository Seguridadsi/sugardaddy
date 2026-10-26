CREATE INDEX "auditoria_cuando" ON "auditoria" USING btree ("cuando");--> statement-breakpoint
CREATE INDEX "cuarentena_recibido" ON "cuarentena" USING btree ("recibido");--> statement-breakpoint
CREATE INDEX "eventos_recibido" ON "eventos" USING btree ("recibido");