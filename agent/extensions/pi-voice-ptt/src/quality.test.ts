import { describe, expect, it } from 'vitest';
import { transcriptProblem } from './quality.js';

describe('transcript acceptance extends the upstream filter', () => {
  it('rejects the reported mixed-English, unspaced Japanese loop', () => {
    const reported = 'Rade Jumping Walks Runs Like Kiyote ' + '日本語の中で、'.repeat(12) + '日本';
    expect(transcriptProblem(reported, 'en')).toContain('repeated-text loop');
  });
  it('detects a repeated suffix even after a valid English prefix', () => {
    expect(transcriptProblem('A valid beginning. ' + 'another strange phrase '.repeat(8), 'en')).toContain(
      'repeated-text loop',
    );
  });
  it('accepts normal English and emphatic words', () => {
    expect(transcriptProblem('The quick brown fox jumps over the lazy dog. Yes, yes, yes!', 'en')).toBeUndefined();
  });
  it('accepts ordinary Japanese when the existing i18n extension selects Japanese', () => {
    expect(transcriptProblem('日本語の文章を正しく認識して表示します。', 'ja')).toBeUndefined();
  });
  it('rejects predominantly unexpected script for English even without repetition', () => {
    expect(transcriptProblem('日本語の文章を勝手に出力しています。', 'en-US')).toContain('inconsistent with English');
  });
  it('preserves short foreign proper names in English text', () => {
    expect(transcriptProblem('I visited 東京 and tried café crème.', 'en')).toBeUndefined();
  });
  it('does not reinterpret other selected languages as English', () => {
    expect(transcriptProblem('Это нормальная русская речь.', 'ru')).toBeUndefined();
  });
  it('treats the i18n SDK undefined locale as its documented English default', () => {
    expect(transcriptProblem('日本語の文章を勝手に出力しています。', undefined)).toContain('inconsistent with English');
  });
  it('does not hallucinate a script mismatch for numbers or blank text', () => {
    expect(transcriptProblem('12345', 'en')).toBeUndefined();
    expect(transcriptProblem('', 'en')).toBeUndefined();
  });
});
