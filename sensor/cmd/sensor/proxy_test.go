package main

import "testing"

func TestProxyPresente(t *testing.T) {
	entorno := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	if proxyPresente(entorno(nil)) {
		t.Fatal("no proxy in the environment")
	}
	if !proxyPresente(entorno(map[string]string{"HTTPS_PROXY": "http://proxy:3128"})) {
		t.Fatal("HTTPS_PROXY")
	}
	if !proxyPresente(entorno(map[string]string{"https_proxy": "http://proxy:3128"})) {
		t.Fatal("https_proxy")
	}
}
