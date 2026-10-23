'use strict';
/*
 * Проверки разбора SwiftUI для предпросмотра.
 *
 * Предпросмотр не исполняет код, поэтому важно, чтобы разбор переживал
 * реальный вид: вложенные контейнеры, модификаторы, условия, строки с кавычками.
 */

import test from 'node:test';
import assert from 'node:assert';

import { parseSwiftUI, renderPreview, extractBody } from '../src/renderer/src/swiftui-preview.js';

const SAMPLE = `
import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(spacing: 12) {
            Text("Заголовок")
                .font(.title)
                .bold()

            HStack {
                Image(systemName: "star.fill")
                Text("Рейтинг")
                    .foregroundColor(.yellow)
                Spacer()
            }
            .padding(16)

            Button("Далее") {
                print("tap")
            }
            .background(Color.blue)
            .cornerRadius(10)
        }
        .padding()
    }
}
`;

test('находит тело вьюхи', () => {
  const { found, body } = extractBody(SAMPLE);
  assert.strictEqual(found, true);
  assert.match(body, /VStack/);
});

test('разбирает вложенность контейнеров', () => {
  const { nodes } = parseSwiftUI(SAMPLE);
  assert.strictEqual(nodes.length, 1);

  const stack = nodes[0];
  assert.strictEqual(stack.name, 'VStack');
  assert.strictEqual(stack.children.length, 3);

  const row = stack.children[1];
  assert.strictEqual(row.name, 'HStack');
  assert.strictEqual(row.children.length, 3);
  assert.deepStrictEqual(row.children.map((c) => c.name), ['Image', 'Text', 'Spacer']);
});

test('берёт текст, шрифт и цвет', () => {
  const { nodes } = parseSwiftUI(SAMPLE);
  const title = nodes[0].children[0];

  assert.strictEqual(title.name, 'Text');
  assert.strictEqual(title.label, 'Заголовок');
  assert.strictEqual(title.style.font, 28, 'title = 28px');
  assert.strictEqual(title.style.weight, 700, 'bold');

  const rating = nodes[0].children[1].children[1];
  assert.strictEqual(rating.label, 'Рейтинг');
  assert.strictEqual(rating.style.color, '#ffd60a');
});

test('понимает systemName у Image', () => {
  const { nodes } = parseSwiftUI(SAMPLE);
  const image = nodes[0].children[1].children[0];
  assert.strictEqual(image.name, 'Image');
  assert.strictEqual(image.label, 'star.fill');
});

test('кнопка получает подпись, фон и радиус', () => {
  const { nodes } = parseSwiftUI(SAMPLE);
  const button = nodes[0].children[2];

  assert.strictEqual(button.name, 'Button');
  assert.strictEqual(button.label, 'Далее');
  // Фон в эскизе приглушённый (с альфой), цвет при этом тот же.
  assert.match(button.style.background, /^#0a84ff[0-9a-f]{2}$/);
  assert.strictEqual(button.style.radius, 10);
});

test('padding из аргумента и без него', () => {
  const { nodes } = parseSwiftUI(SAMPLE);
  assert.strictEqual(nodes[0].children[1].style.padding, 16);
  assert.strictEqual(nodes[0].style.padding, 8, 'padding() без числа = 8');
});

test('условие показывается отдельным блоком', () => {
  const source = `
    var body: some View {
        VStack {
            if isLoading {
                ProgressView()
            } else {
                Text("готово")
            }
        }
    }
  `;
  const { nodes } = parseSwiftUI(source);
  const stack = nodes[0];
  const conditional = stack.children.find((c) => c.kind === 'conditional');

  assert.ok(conditional, 'условие должно быть в дереве');
  assert.match(conditional.condition, /isLoading/);
  assert.strictEqual(conditional.children[0].name, 'ProgressView');
});

test('неизвестный элемент не ломает разбор', () => {
  const source = `
    var body: some View {
        VStack {
            SomeCustomWidget(style: .fancy)
            Text("после")
        }
    }
  `;
  const { nodes } = parseSwiftUI(source);
  const stack = nodes[0];
  assert.deepStrictEqual(stack.children.map((c) => c.name), ['SomeCustomWidget', 'Text']);
});

test('строки с кавычками внутри не рвут разбор', () => {
  const source = `
    var body: some View {
        Text("он сказал \\"привет\\"")
    }
  `;
  const { nodes } = parseSwiftUI(source);
  assert.strictEqual(nodes.length, 1);
  assert.strictEqual(nodes[0].label, 'он сказал "привет"');
});

test('файл без body даёт предупреждение, а не падение', () => {
  const { found, nodes, warnings } = parseSwiftUI('import Foundation\nlet x = 1\n');
  assert.strictEqual(found, false);
  assert.deepStrictEqual(nodes, []);
  assert.ok(warnings.some((w) => /body/.test(w)));
});

test('рендер выдаёт разметку для контейнера и текста', () => {
  const { nodes } = parseSwiftUI(SAMPLE);
  const html = renderPreview(nodes);

  assert.match(html, /pv-col/, 'VStack → колонка');
  assert.match(html, /pv-row/, 'HStack → строка');
  assert.match(html, /Заголовок/);
  assert.match(html, /pv-button/);
});

test('неизвестный элемент рисуется заглушкой', () => {
  const html = renderPreview([
    { kind: 'view', name: 'Mystery', args: '', label: null, style: {}, children: [] },
  ]);
  assert.match(html, /Mystery/);
  assert.match(html, /не распознан/);
});

test('пустое дерево даёт понятное сообщение', () => {
  const html = renderPreview([]);
  assert.match(html, /Нечего показать/);
});
