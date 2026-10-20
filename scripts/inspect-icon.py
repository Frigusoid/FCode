"""Разбор иконок внутри .ipa: размеры, прозрачность, границы картинки."""
import io
import sys
import zipfile

from PIL import Image

IPA = sys.argv[1] if len(sys.argv) > 1 else r'Q:\Downloads\bbb\HelloWorld\build\HelloWorld.ipa'


def main():
    with zipfile.ZipFile(IPA) as archive:
        names = [n for n in archive.namelist() if '/AppIcon' in n and n.lower().endswith('.png')]
        print(f'иконок в архиве: {len(names)}')

        for name in sorted(names):
            data = archive.read(name)
            image = Image.open(io.BytesIO(data))

            info = {
                'файл': name.split('/')[-1],
                'размер': image.size,
                'режим': image.mode,
                'байт': len(data),
            }

            rgba = image.convert('RGBA')
            alpha = rgba.getchannel('A')
            info['альфа мин'] = alpha.getextrema()[0]

            # Границы непрозрачных пикселей: если картинка занимает не весь
            # квадрат, значит её вписали, а не обрезали.
            bbox = alpha.getbbox()
            info['непрозрачное'] = bbox

            # Границы непустых пикселей (отличающихся от однотонного фона).
            rgb = rgba.convert('RGB')
            colors = rgb.getcolors(maxcolors=1_000_000) or []
            dominant = max(colors)[1] if colors else None
            info['основной цвет'] = dominant

            print('  ' + ', '.join(f'{k}: {v}' for k, v in info.items()))


if __name__ == '__main__':
    main()
