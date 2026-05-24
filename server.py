#!/usr/bin/env python3
"""
Servidor HTTP para SeenIt
Ejecuta: python server.py
Accede a: http://localhost:5500
"""

import http.server
import socketserver
import os
import sys
from pathlib import Path

# Configuración
PORT = 5500
DIRECTORY = Path(__file__).parent

class CORSRequestHandler(http.server.SimpleHTTPRequestHandler):
    """Maneja requests HTTP con CORS habilitado"""
    
    def end_headers(self):
        """Añade headers CORS a las respuestas"""
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        
        # Headers necesarios para Google OAuth con popups
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        
        super().end_headers()
    
    def do_OPTIONS(self):
        """Maneja OPTIONS requests"""
        self.send_response(200)
        self.end_headers()
    
    def translate_path(self, path):
        """Traduce la ruta del request al filesystem"""
        # Cambiar al directorio donde está el script
        os.chdir(DIRECTORY)
        return super().translate_path(path)
    
    def log_message(self, format, *args):
        """Personaliza los logs"""
        try:
            if len(args) > 0 and isinstance(args[0], str) and args[0].startswith('GET'):
                sys.stderr.write(f"[SeenIt] {format % args}\n")
            elif len(args) > 0 and isinstance(args[0], str):
                sys.stderr.write(f"[SeenIt] {format % args}\n")
        except:
            # Si hay algún error en el logging, ignorar
            pass


def run_server():
    """Inicia el servidor"""
    os.chdir(DIRECTORY)
    
    try:
        with socketserver.TCPServer(("", PORT), CORSRequestHandler) as httpd:
            print(f"""
╔═══════════════════════════════════════════╗
║      🎬 SeenIt Server iniciado 🎬        ║
╠═══════════════════════════════════════════╣
║                                           ║
║  URL: http://localhost:{PORT}               ║
║  Puerto: {PORT}                               ║
║  Directorio: {DIRECTORY}         ║
║                                           ║
║  Presiona Ctrl+C para detener            ║
║                                           ║
╚═══════════════════════════════════════════╝
            """)
            print(f"Sirviendo archivos desde: {DIRECTORY}\n")
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n\n✓ Servidor detenido")
        sys.exit(0)
    except OSError as e:
        if e.errno == 48 or e.errno == 98:
            print(f"\n❌ El puerto {PORT} ya está en uso")
            print("Soluciones:")
            print(f"1. Cierra la aplicación usando el puerto {PORT}")
            print(f"2. Cambia el puerto editando 'PORT = {PORT}' en este archivo")
            sys.exit(1)
        else:
            raise


if __name__ == '__main__':
    run_server()
