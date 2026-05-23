/**
 * Encode raw PCM Float32 samples as a 16-bit mono WAV buffer.
 * whisper.cpp expects 16 kHz, 16-bit, mono WAV.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
	const bitsPerSample = 16;
	const bytesPerSample = bitsPerSample / 8;
	const dataSize = samples.length * bytesPerSample;
	const buf = Buffer.alloc(44 + dataSize);

	// RIFF header
	buf.write("RIFF", 0);
	buf.writeUInt32LE(36 + dataSize, 4);
	buf.write("WAVE", 8);

	// fmt sub-chunk
	buf.write("fmt ", 12);
	buf.writeUInt32LE(16, 16); // sub-chunk size
	buf.writeUInt16LE(1, 20); // PCM format
	buf.writeUInt16LE(1, 22); // mono
	buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
	buf.writeUInt16LE(bytesPerSample, 32); // block align
	buf.writeUInt16LE(bitsPerSample, 34);

	// data sub-chunk
	buf.write("data", 36);
	buf.writeUInt32LE(dataSize, 40);

	let offset = 44;
	for (let i = 0; i < samples.length; i++) {
		const clamped = Math.max(-1, Math.min(1, samples[i]));
		const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
		buf.writeInt16LE(Math.round(int16), offset);
		offset += 2;
	}

	return buf;
}
