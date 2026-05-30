import os
import webview
from pipewire_api import PipewireAPI

def main():
    api = PipewireAPI()
    api.start()

    html_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'frontend', 'index.html')
    window = webview.create_window(
        'Pipewire Viewer',
        f'file://{html_path}',
        js_api=api,
        width=1400,
        height=900,
        min_size=(800, 600),
    )

    try:
        webview.start(debug=False)
    finally:
        api.stop()

if __name__ == '__main__':
    main()
