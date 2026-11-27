import test from 'node:test';
import assert from 'node:assert/strict';
import {microphoneEnvelope, recordingPresentation, computerControlPresentation, messagePresentation} from './activity_feedback.mjs';

test('waveform reflects real sample energy and stays flat for silence', () => {
  assert(microphoneEnvelope(new Float32Array(512)).every(v => v === 0));
  const voice = Float32Array.from({length:512},(_,i)=>Math.sin(i / 7) * .1);
  assert(microphoneEnvelope(voice).every(v => v > .2 && v < 1));
  assert(microphoneEnvelope(new Float32Array(512).fill(1)).every(v=>v===1));
});
test('recording exposes stop, elapsed time and processing without a false recording signal', () => {
  assert.deepEqual(recordingPresentation({recording:true,startedAt:1000},66000),
    {visible:true,stop:true,label:'Stop dictation',text:'Recording · 1:05'});
  const stopped=recordingPresentation({recording:false,busy:true},66000);
  assert.equal(stopped.stop,false);assert.equal(stopped.text,'Processing audio…');
  assert.equal(recordingPresentation({recording:false,busy:false}).visible,false);
});
test('computer indicator follows confirmed desktop control and exposes stale status', () => {
  assert.equal(computerControlPresentation({running:true,desktopCaptureSuppressed:false}).active,true);
  for (const payload of [{running:false,desktopCaptureSuppressed:false},{running:true,desktopCaptureSuppressed:true},{}])
    assert.equal(computerControlPresentation(payload).visible,false);
  const stale=computerControlPresentation(null,true);assert.equal(stale.active,false);assert.match(stale.text,/unavailable/);
  const stopped=computerControlPresentation({running:true,desktopCaptureSuppressed:false,stopRequested:true});
  assert.equal(stopped.active,false);assert.match(stopped.text,/stopped/);assert.match(stopped.text,/settle/);
});
test('resume is an activity; identical text actually typed by a user stays a user message', () => {
  const text='Continue the existing task using its saved answers and evidence.';
  assert.equal(messagePresentation({role:'user',text}).role,'user');
  assert.deepEqual(messagePresentation({role:'user',text,controlAction:'resume'}),
    {role:'activity',label:'Task activity',text:'Task resumed'});
});
