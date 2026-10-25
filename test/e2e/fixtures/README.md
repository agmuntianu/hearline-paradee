# Model fixtures for the real browser tests

These files are **not** in git (the models are 9 MB and 92 MB). The e2e tests use them so a
test run does not depend on Hugging Face, and so the download path can be exercised without
a flaky connection. `test/e2e/paradee.mjs` and `test/e2e/kokoro.mjs` fall back to the real
network when the files are missing, so the tests still run (slowly) without them.

Fetch them once:

```bash
mkdir -p test/e2e/fixtures
# the fast voice: pinned revision, checksum must match src/offscreen/paradee-core.js
curl -L -o test/e2e/fixtures/paradee_int8.onnx \
  "https://huggingface.co/sahilmahendrakar/Paradee-8M-v1.0/resolve/c7f83f86c04e84d0ae94cbe1aad7618e0544f80a/onnx/paradee_int8.onnx"
sha256sum test/e2e/fixtures/paradee_int8.onnx   # 60e8f8a1bc7c546488154e9d99ecac6e9c50baf3f4b684c5b0de48ea03b698eb

# the larger voice set, mirrored under fixtures/hf/<host>/<path> so it can be served over
# http://127.0.0.1/... in place of the real host (see mirrorHfFixtures in test/e2e/env.mjs)
for p in config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx \
         voices/af_heart.bin voices/af_bella.bin voices/af_nicole.bin \
         voices/am_michael.bin voices/bf_emma.bin voices/bm_george.bin; do
  d=test/e2e/fixtures/hf/huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main
  mkdir -p "$d/$(dirname $p)" && curl -L -o "$d/$p" "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/$p"
done
```
