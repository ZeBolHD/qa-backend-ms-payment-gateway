import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ClientKafka } from "@nestjs/microservices";
import { PrismaService } from "@prisma/prisma.service";
import { Status } from "@prisma/client";

import { CardCheckerResponse, PaymentRegistryResponse } from "./responses";
import { CardCheckerDto, CreatePaymentDto, FindAllQueryDto, PaymentRegistryDto } from "./dto";
import { PinoLogger } from "nestjs-pino";

@Injectable()
export class PaymentService {
  constructor(
    @Inject("CARD_CHECKER_SERVICE") private checkerClient: ClientKafka,
    @Inject("REGISTRY_SERVICE") private registryClient: ClientKafka,
    private readonly prismaService: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PaymentService.name);
  }

  async findAllPayments(dto: FindAllQueryDto) {
    this.logger.info({ query: dto }, "Find payments");

    const payments = await this.prismaService.payment
      .findMany({
        where: {
          status: dto.status,
        },
        take: dto.pageSize,
        skip: dto.page * dto.pageSize - dto.pageSize,
        orderBy: {
          createdAt: dto.createdAt,
        },
      })
      .catch((e) => {
        this.logger.debug(e, "Failed find payments");
        throw new ServiceUnavailableException("Сервис недоступен");
      });

    const count = await this.prismaService.payment
      .aggregate({
        _count: true,
        where: {
          status: dto.status,
        },
      })
      .then((res) => res._count)
      .catch(() => 0);

    const pageCount = Math.ceil(count / dto.pageSize);

    this.logger.info(
      { count, page: dto.page, pageSize: dto.pageSize, pageCount },
      "Found payments",
    );

    return { payments, count, page: dto.page, pageSize: dto.pageSize, pageCount };
  }

  async findAllUserPaymentsByUserId(userId: string) {
    this.logger.info({ user: { id: userId } }, "Find all user payments by userId");

    const user = await this.prismaService.user
      .findUnique({
        where: {
          id: userId,
        },
        select: {
          id: true,
        },
      })
      .catch((e) => {
        this.logger.debug(e, "Failed find user payments");
        this.logger.error({ user: { id: userId } }, "Failed find user payments by userId");
        throw new ServiceUnavailableException("Сервис недоступен");
      });

    if (!user) {
      this.logger.error("Failed find user payments by userId. User not found");
      throw new NotFoundException("Пользователь не найден");
    }

    const payments = await this.prismaService.payment
      .findMany({
        where: {
          userId,
        },
      })
      .catch((e) => {
        this.logger.error(e, "Failed find user payments");
        this.logger.info({ user: { id: userId } }, "Failed find user payments. User not found");
        throw new ServiceUnavailableException("Сервис недоступен");
      });

    this.logger.info(
      {
        payments: {
          count: payments.length,
        },
      },
      "Found user payments",
    );

    return payments;
  }

  async findAllUserPayments(userId: string) {
    this.logger.info({ user: { id: userId } }, "Find all user payments");

    const payments = await this.prismaService.payment
      .findMany({
        where: {
          userId,
        },
      })
      .catch((e) => {
        this.logger.debug(e, "Failed find all user payments");
        this.logger.error({ user: { id: userId } }, "Failed find all user payments");
        throw new ServiceUnavailableException("Сервис недоступен");
      });

    this.logger.info(
      {
        payments: {
          count: payments.length,
        },
      },
      "Found all user payments",
    );

    return payments;
  }

  async createPayment(userId: string, dto: CreatePaymentDto) {
    this.logger.info({ user: { id: userId }, dto }, "Create payment");

    const user = await this.prismaService.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        id: true,
      },
    });

    if (!user) {
      this.logger.error({ user: { id: userId } }, "User not found");
      throw new NotFoundException("Пользователь не найден");
    }

    const movie = await this.prismaService.movie
      .findUnique({
        where: {
          id: dto.movieId,
        },
        select: {
          id: true,
          price: true,
        },
      })
      .catch((e) => {
        this.logger.debug(e, "Failed create payment. Movie not found");
        this.logger.error(
          { user: { id: userId }, movie: { id: dto.movieId } },
          "Failed create payment. Movie not found",
        );
        throw new NotFoundException("Фильм не найден");
      });

    if (!movie) {
      this.logger.error({ movie: { id: dto.movieId } }, "Failed create payment. Movie not found");
      throw new NotFoundException("Фильм не найден");
    }

    const total = movie.price * dto.amount;

    const cardCheckerDto: CardCheckerDto = {
      total,
      card: dto.card,
    };

    this.logger.trace({ user: { id: userId } }, "Sending data to card checker...");

    const cardCheckerResponse = await this.sendMessageWithTimeoutError<
      CardCheckerResponse,
      CardCheckerDto
    >(this.checkerClient, "create.payment", cardCheckerDto).catch(() => {
      this.logger.error(
        { user: { id: userId } },
        "Failed create payment. Card checker unavailable",
      );
      throw new ServiceUnavailableException("Сервис карт временно недоступен");
    });

    const cardCheckerStatus = cardCheckerResponse.status;

    this.logger.trace({ user: { id: userId }, cardCheckerStatus }, "Card checked");

    const paymentRegistryDto: PaymentRegistryDto = {
      userId,
      movieId: dto.movieId,
      total,
      amount: dto.amount,
      status: cardCheckerStatus,
    };

    this.logger.trace({ user: { id: userId } }, "Sending data to payment registry...");

    const paymentRegistryResponse = await this.sendMessageWithTimeoutError<
      PaymentRegistryResponse,
      PaymentRegistryDto
    >(this.registryClient, "register.payment", paymentRegistryDto).catch(() => {
      this.logger.error(
        { user: { id: userId } },
        "Failed create payment. Payment registry unavailable",
      );
      throw new ServiceUnavailableException("Сервис регистрации платежа временно недоступен");
    });

    if (!paymentRegistryResponse) {
      this.logger.error({ user: { id: userId } }, "Failed create payment. Payment registry error");
      throw new BadRequestException("Произошла ошибка при регистрации платежа");
    }

    this.logger.trace({ user: { id: userId } }, "Payment registered");

    this.logger.info({ user: { id: userId } }, "Payment created");

    switch (cardCheckerStatus) {
      case Status.SUCCESS:
        return cardCheckerResponse;

      case Status.INVALID_CARD:
        throw new BadRequestException({
          message: "Неверная карта",
          error: cardCheckerResponse,
        });

      default:
        throw new InternalServerErrorException("Произошла ошибка при регистрации платежа");
    }
  }

  async sendMessageWithTimeoutError<TResponse, TBody>(
    client: ClientKafka,
    topic: string,
    data: TBody,
    timeout: number = 3000,
  ): Promise<TResponse> {
    return new Promise<TResponse>((resolve, reject) => {
      let timerId: NodeJS.Timeout;

      const subscription = client.send<TResponse, TBody>(topic, data).subscribe({
        next: (res) => {
          resolve(res);
          clearTimeout(timerId);
        },
        error: () => {
          reject();
          //subscription.unsubscribe();
        },
      });

      timerId = setTimeout(() => {
        reject();
        //subscription.unsubscribe();
      }, timeout);
    });
  }
}
