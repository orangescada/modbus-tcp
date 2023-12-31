# OrangeScada Modbus TCP driver

## Установка

Для работы использовать версию [Node.js](https://nodejs.org/) v16+

Для установки использовать команды

```sh
git clone https://github.com/orangescada/modbus-tcp
cd modbus-tcp
npm i
npm start
```
## Подключение к OrangeScada

Если использовать стандартный конфиг драйвера, то со стороны OrangeScada должен быть настроена работа с универсальным драйвером:
- порт: 8892
- ssl: выключено
- идентификатор драйвера: 1234
- пароль: password

## Добавление modbus узлов, устройств и переменных

Добавлять узлы, устройства и переменные можно как при помощи интерфейса самой скады (через инструмент Драйвер), так и путем редактирования файла driverConfig.json (на момент редактирования драйвер необходимо остановить). Набор свойств для modbus узлов устройств и тегов можно взять из раздела `optionsScheme` в этом же конфиг-файле 

## Диагностика

При нормальном подключении драйвера в панели инструментов скады зажигается галочка "Коннект". Если подключение произошло неудачно, то причины следует искать в скаде (функция `Диагностика`) и в логах драйвера. Логи активны, если в модуле driver.js активна константа log:
```sh
//*****************************************************************
// LOGGER PART
//*****************************************************************


const log = true;
```

## Запуск драйвера как службы (для Windows)

Необходимо в папке драйвера выполнить команду

```sh
npm run installService
```

При удачном исполнении в списке служб появится `OrangeScadaModbusTCPDriver`, управляя которой можно запускать/останавливать универсальный драйвер

## License

MIT

