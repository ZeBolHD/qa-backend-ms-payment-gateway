import { Module } from "@nestjs/common";
import { PaymentController } from "./payment/payment.controller";
import { PaymentService } from "./payment/payments.service";
import { ClientsModule, Transport } from "@nestjs/microservices";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "@auth/auth.module";
import { APP_GUARD } from "@nestjs/core";
import { JwtAuthGuard } from "@auth/guards/jwt-auth.guard";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";

@Module({
  imports: [
    LoggerModule.forRoot(),
    ClientsModule.registerAsync([
      {
        name: "CARD_CHECKER_SERVICE",
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.KAFKA,
          options: {
            client: {
              clientId: "card-checker",
              brokers: [configService.get<string>("KAFKA_BROKER", "localhost:9092")],
            },
            consumer: {
              heartbeatInterval: 5000,
              rebalanceTimeout: 5000,
              groupId: "checker-consumer",
            },
          },
        }),
        inject: [ConfigService],
      },
      {
        name: "REGISTRY_SERVICE",
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.KAFKA,
          options: {
            client: {
              clientId: "registry",
              brokers: [configService.get<string>("KAFKA_BROKER", "localhost:9092")],
            },
            consumer: {
              heartbeatInterval: 5000,
              rebalanceTimeout: 5000,
              groupId: "registry-consumer",
            },
          },
        }),
        inject: [ConfigService],
      },
    ]),
    PrismaModule,
    AuthModule,
    ConfigModule.forRoot({ isGlobal: true }),
  ],
  controllers: [PaymentController],
  providers: [
    PaymentService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
