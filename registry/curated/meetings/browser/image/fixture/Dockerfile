# The meeting fixture: the page with the adapters' selectors, its server, and the known recording, which is spoken from
# recording.txt when the image is built (espeak-ng's American English voice at its default 175 words a minute, about
# twenty seconds), then written as 16 kHz mono 16-bit PCM by sox. Built from the pack's folder by image/test/compose.yml:
#   docker build -f image/fixture/Dockerfile .
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends espeak-ng sox \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /fixture
COPY image/fixture/index.html image/fixture/chat-frame.html image/fixture/serve.mjs image/fixture/recording.txt ./
RUN espeak-ng -v en-us -f recording.txt -w speech.wav \
  && sox speech.wav -r 16000 -c 1 -b 16 recording.wav \
  && rm speech.wav
USER node
EXPOSE 8787
CMD ["node", "serve.mjs"]
