package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync/atomic"
)

func main() {
	port := "8080"
	if len(os.Args) > 1 {
		port = os.Args[1]
	}
	var count atomic.Uint64
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		current := count.Add(1)
		defer r.Body.Close()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Connection", "close")
		body, err := io.ReadAll(io.LimitReader(r.Body, 65537))
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"Cannot read body"}`))
			return
		}
		if len(body) > 65536 {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			_, _ = w.Write([]byte(`{"error":"Body too large"}`))
			return
		}
		payload, err := json.Marshal(struct {
			Family string `json:"family"`
			Method string `json:"method"`
			Path   string `json:"path"`
			Body   string `json:"body"`
			Count  uint64 `json:"count"`
		}{"go", r.Method, r.RequestURI, string(body), current})
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		_, _ = w.Write(payload)
	})
	log.Fatal(http.ListenAndServe("0.0.0.0:"+port, handler))
}
