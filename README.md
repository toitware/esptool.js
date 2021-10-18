# esptool.js

[![npm](https://img.shields.io/npm/v/@toit/esptool.js.svg?style=flat-square)](https://www.npmjs.org/package/@toit/esptool.js)
[![npm](https://img.shields.io/npm/l/@toit/esptool.js.svg?style=flat-square)](https://www.npmjs.org/package/@toit/esptool.js)
[![typedoc](https://img.shields.io/badge/-typedoc-blue?style=flat-square)](https://toitware.github.io/esptool.js)
[![GitHub](https://img.shields.io/github/stars/toitware/esptool.js.svg?style=flat-square)](https://github.com/toitware/esptool.js)


TypeScript port of the esptool.

The [esptool](https://github.com/espressif/esptool) is originally written in python, and we have here ported it to TypeScript.

This implementation is used in the [Toit Console](https://console.toit.io) to allow users to flash and monitor ESP32:

[![Flash ESP32 with web serial](https://img.youtube.com/vi/ZsD59Tg2oCQ/0.jpg)](https://www.youtube.com/watch?v=ZsD59Tg2oCQ)

Blog post on why we started this project: [Flash your ESP32 from the browser using Web Serial](https://blog.toit.io/flash-your-esp32-from-the-browser-using-web-serial-5eccb1483b9c).

## Example

The code is written as a library, here is an examples showcasing how you can flash an ESP32 using the library:

```typescript
export type Partition = {
  name: string;
  data: Uint8Array;
  offset: number;
};

// TODO: Here you have to specify the partitions you want to flash to the ESP32.
const partitions: Partition[] = [];

await port.open({ baudRate: 115200 });
try {
  const loader = new EspLoader(port, { debug: true, logger: console });
  options.logger.log("connecting...");
  await loader.connect();
  try {
    options.logger.log("connected");
    options.logger.log("writing device partitions");
    const chipName = await loader.chipName();
    const macAddr = await loader.macAddr();
    await loader.loadStub();
    await loader.setBaudRate(options.baudRate, 921600);

    if (options.erase) {
      options.logger.log("erasing device flash...");
      await loader.eraseFlash();
      options.logger.log("successfully erased device flash");
    }

    for (let i = 0; i < partitions.length; i++) {
      options.logger.log("\nWriting partition: " + partitions[i].name);
      await loader.flashData(partitions[i].data, partitions[i].offset, function (idx, cnt) {
        if (options.progressCallback) {
          options.progressCallback(partitions[i].name, idx, cnt);
        }
      });
      await sleep(100);
    }
    options.logger.log("successfully written device partitions");
    options.logger.log("flashing succeeded");
  } finally {
    await loader.disconnect();
  }
} finally {
  await port.close();
}
```

## Development
To have automatic checks for copyright and MIT notices, run

```
$ git config core.hooksPath .githooks
```

If a file doesn't need a copyright/MIT notice, use the following to skip
the check:
```
git commit --no-verify
```

## Similar projects

* [Espressif esptool-js](https://github.com/espressif/esptool-js): new project with similar purpose, but still not written as a proper library.

* [Adafruit Adafruit ESPTool](https://github.com/adafruit/Adafruit_WebSerial_ESPTool): the source of inspration for us, big shout-out thanks for spearheading the effort. The implementation is written as a application and hard to use as a library.
