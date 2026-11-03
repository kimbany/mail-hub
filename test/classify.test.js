const test = require('node:test');
const assert = require('node:assert');
const { classify } = require('../src/mail');

const msg = { from: '쿠팡 <no-reply@coupang.com>', to: 'me+shop@naver.com', subject: '[청구서] 11월 카드 이용대금' };

test('처음 맞는 규칙의 분류를 쓴다', () => {
  const rules = [
    { category: '청구서', field: 'subject', keyword: '청구서' },
    { category: '쇼핑', field: 'from', keyword: 'coupang' },
  ];
  assert.strictEqual(classify(msg, rules), '청구서');
});

test('대소문자 구분 없이 보낸사람·받는사람에서 찾는다', () => {
  assert.strictEqual(classify(msg, [{ category: '쇼핑', field: 'from', keyword: 'COUPANG' }]), '쇼핑');
  assert.strictEqual(classify(msg, [{ category: '별칭', field: 'to', keyword: '+shop' }]), '별칭');
});

test('맞는 규칙이 없으면 null (미분류)', () => {
  assert.strictEqual(classify(msg, [{ category: '회사', field: 'from', keyword: 'company.com' }]), null);
  assert.strictEqual(classify({ subject: 'x' }, [{ category: 'a', field: 'to', keyword: 'y' }]), null);
});
