.PHONY: build test run lint docker-build docker-run clean

build:
	npm run build

test:
	npm test

run:
	npm start

lint:
	npm run lint

docker-build:
	docker build -t ai-crypto-onramp/notifier .

docker-run:
	docker run --rm -p 8080:8080 ai-crypto-onramp/notifier

clean:
	rm -rf dist node_modules coverage
