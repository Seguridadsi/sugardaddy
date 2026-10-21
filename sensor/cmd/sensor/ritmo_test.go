package main

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/kinomakino/sugardaddy/sensor/internal/evento"
	"github.com/kinomakino/sugardaddy/sensor/internal/plan"
)

var minutoPrueba = time.Date(2026, 10, 17, 10, 0, 0, 0, time.UTC)

func trampaPrueba() plan.TrampaPlan {
	var tp plan.TrampaPlan
	tp.ID, tp.Manifiesto.ID, tp.Manifiesto.Tipo = "web", "retencion-web", "contenedor"
	return tp
}

func ev(ms int, ip, severidad string) evento.Evento {
	e := evento.Evento{Cuando: minutoPrueba.Add(time.Duration(ms) * time.Millisecond).Format(time.RFC3339Nano), Severidad: severidad, Accion: "otra"}
	e.Origen.IP = ip
	return e
}

func TestElRuidoNoTapaLoGrave(t *testing.T) {
	r, tp := ritmo{}, trampaPrueba()
	// 1000 eventos leves de muchas IP (un barrido con orígenes falsos): pasan
	// los de la reserva de IP nuevas y el cupo de leves, y nada más.
	pasan := 0
	for i := 0; i < 1000; i++ {
		if ok, _ := r.pasa("s", tp, ev(i, fmt.Sprintf("10.0.%d.%d", i/250, i%250), "baja")); ok {
			pasan++
		}
	}
	if pasan != reservaNuevas+porMinuto {
		t.Fatalf("leves que pasan: %d, el tope es %d", pasan, reservaNuevas+porMinuto)
	}
	// Un evento crítico de otra IP en el mismo minuto pasa igual.
	if ok, _ := r.pasa("s", tp, ev(800, "198.51.100.7", "critica")); !ok {
		t.Fatal("lo crítico tiene su propio cupo")
	}
}

func TestUnaIPNoSeComeElCupoDeLasDemas(t *testing.T) {
	r, tp := ritmo{}, trampaPrueba()
	for i := 0; i < 300; i++ {
		r.pasa("s", tp, ev(i, "203.0.113.9", "media"))
	}
	if ok, _ := r.pasa("s", tp, ev(400, "203.0.113.9", "media")); ok {
		t.Fatal("una sola IP tiene su cupo por minuto")
	}
	if ok, _ := r.pasa("s", tp, ev(401, "192.0.2.1", "media")); !ok {
		t.Fatal("otra IP sigue pasando")
	}
}

func TestElResumenDiceQueSeHaOmitido(t *testing.T) {
	r, tp := ritmo{}, trampaPrueba()
	for i := 0; i < 150; i++ {
		r.pasa("s", tp, ev(i, "203.0.113.9", "media"))
	}
	for i := 0; i < 700; i++ {
		r.pasa("s", tp, ev(200+i, "203.0.113.10", "alta"))
	}
	ok, resumen := r.pasa("s", tp, evento.Evento{Cuando: minutoPrueba.Add(time.Minute).Format(time.RFC3339Nano), Severidad: "baja"})
	if !ok || resumen == nil {
		t.Fatal("el primer evento del minuto siguiente trae el resumen")
	}
	d := resumen.Detalle
	// Cada IP: sus 100 leves o sus 150 graves (contando sus primeros).
	if d["omitidos"] != 600 || resumen.Severidad != "alta" || resumen.Trampa.Modulo != "retencion-web" {
		t.Fatalf("resumen: %+v", resumen)
	}
	if ps := d["porSeveridad"].(map[string]int); ps["media"] != 50 || ps["alta"] != 550 {
		t.Fatalf("desglose por severidad: %v", ps)
	}
	if d["muestra"] == nil {
		t.Fatal("lleva una muestra de lo grave omitido")
	}
}

func TestPonerseAlDiaNoCuentaYLosResumenesSobrevivenAlReinicio(t *testing.T) {
	tp := trampaPrueba()
	r := ritmo{}
	for i := 0; i < 2000; i++ {
		if ok, _ := r.pasa("s", tp, evento.Evento{Cuando: minutoPrueba.Add(time.Duration(i) * time.Second).Format(time.RFC3339Nano), Severidad: "baja"}); !ok {
			t.Fatal("eventos repartidos en el tiempo no se omiten")
		}
	}
	r = ritmo{}
	for i := 0; i < reservaNuevas+porMinuto+50; i++ {
		r.pasa("s", tp, ev(i, fmt.Sprintf("10.1.%d.%d", i/250, i%250), "baja"))
	}
	if v := r.vencidos("s", minutoPrueba.Add(3*time.Minute), map[string]bool{"web": true}); len(v) != 0 {
		t.Fatal("mientras la trampa sigue leyendo, su minuto no se cierra")
	}
	// Se guarda en el estado y se recupera tras un reinicio, aunque la trampa ya no esté en el plan.
	b, _ := json.Marshal(r.pendientes())
	var guardadas []ventana
	if err := json.Unmarshal(b, &guardadas); err != nil {
		t.Fatal(err)
	}
	r2 := ritmoDe(guardadas)
	v := r2.vencidos("s", minutoPrueba.Add(3*time.Minute), nil)
	if len(v) != 1 || v[0].Detalle["omitidos"] != 50 || v[0].Trampa.Modulo != "retencion-web" || v[0].Trampa.Tipo != "contenedor" {
		t.Fatalf("vencidos tras reiniciar: %+v", v)
	}
}

func TestUnaIPConEventosGravesNoTapaLosDeOtra(t *testing.T) {
	r, tp := ritmo{}, trampaPrueba()
	// hydra: cientos de logins fallidos (alta) desde una sola IP.
	for i := 0; i < 700; i++ {
		r.pasa("s", tp, ev(i, "203.0.113.9", "alta"))
	}
	if ok, _ := r.pasa("s", tp, ev(800, "203.0.113.9", "alta")); ok {
		t.Fatal("una IP tiene su cupo de graves")
	}
	// El login correcto y el comando de otro atacante pasan.
	for i, sev := range []string{"critica", "critica", "alta", "critica"} {
		if ok, _ := r.pasa("s", tp, ev(900+i, "198.51.100.7", sev)); !ok {
			t.Fatalf("el evento %d de otra IP tiene que pasar", i)
		}
	}
}

func TestLosPrimerosDeCadaIPNuevaPasanAunqueTodoEsteLleno(t *testing.T) {
	r, tp := ritmo{}, trampaPrueba()
	for i := 0; i < 1500; i++ {
		r.pasa("s", tp, ev(i, fmt.Sprintf("10.2.%d.%d", i/250, i%250), "critica"))
	}
	// Gastado todo, una IP más se ve igual (su primer evento).
	if ok, _ := r.pasa("s", tp, ev(1600, "192.0.2.77", "baja")); !ok {
		t.Fatal("el primer evento de una IP nueva sale de la reserva")
	}
}

func evc(ms int, ip, nativa, accion, severidad string) evento.Evento {
	e := ev(ms, ip, severidad)
	e.Nativa, e.Accion = nativa, accion
	return e
}

// La revisión: una sesión que mete basura antes de descargar no se tapa su descarga.
func TestUnaSesionNoTapaSuPropiaDescarga(t *testing.T) {
	r, tp := ritmo{}, trampaPrueba()
	ip := "203.0.113.9"
	for i, n := range []string{"cowrie.session.connect", "cowrie.client.version", "cowrie.client.kex"} {
		r.pasa("s", tp, evc(i, ip, n, "conexion", "baja"))
	}
	r.pasa("s", tp, evc(3, ip, "cowrie.login.success", "autenticacion", "alta"))
	for i := 0; i < 200; i++ {
		r.pasa("s", tp, evc(10+2*i, ip, "cowrie.command.input", "comando", "critica"))
		r.pasa("s", tp, evc(11+2*i, ip, "cowrie.command.failed", "comando", "critica"))
	}
	if ok, _ := r.pasa("s", tp, evc(900, ip, "cowrie.session.file_download", "descarga", "critica")); !ok {
		t.Fatal("la descarga de la sesión tiene que llegar")
	}
}

// La revisión: con el cupo de graves lleno por varios hydra, otro atacante se ve entero.
func TestConHydraLlenandoElCupoOtroAtacanteSeVe(t *testing.T) {
	r, tp := ritmo{}, trampaPrueba()
	for k := 0; k < 5; k++ {
		ip := fmt.Sprintf("198.51.100.%d", k+1)
		for i := 0; i < 200; i++ {
			r.pasa("s", tp, evc(k*1000+i, ip, "cowrie.login.failed", "autenticacion", "alta"))
		}
	}
	nuevo := "192.0.2.50"
	for i, n := range []string{"cowrie.session.connect", "cowrie.client.version", "cowrie.client.kex"} {
		r.pasa("s", tp, evc(6000+i, nuevo, n, "conexion", "baja"))
	}
	for i, x := range [][3]string{{"cowrie.login.success", "autenticacion", "alta"}, {"cowrie.command.input", "comando", "critica"}, {"cowrie.session.file_download", "descarga", "critica"}} {
		if ok, _ := r.pasa("s", tp, evc(6100+i, nuevo, x[0], x[1], x[2])); !ok {
			t.Fatalf("%s del atacante nuevo tiene que llegar", x[0])
		}
	}
}
