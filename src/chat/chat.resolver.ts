import {
  ResolveField,
  Parent,
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
} from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ChatService } from './chat.service';
import { Conversation } from './schemas/conversation.schema';
import { Message } from './schemas/message.schema';
import {
  SendMessageInput,
  StartConversationInput,
  StartCourierConversationInput,
} from './dto/chat.input';
import { AdminConversationsInput } from './dto/admin-conversations.input';
import { PaginatedConversations } from './models/paginated-conversations.model';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveBranch } from '../auth/decorators/active-branch.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';

// Customers, providers, and couriers all use chat; the startConversation
// mutations are customer-only (enforced in the service).
// Staff chat AS THE BRANCH, not as themselves: ChatService resolves them
// through their employer, so a customer keeps one continuous thread with the
// business regardless of who is on shift. Which branch, and whether they may
// answer at all, is decided per branch by the Orders grant — see
// @RequirePermissions below.
const CHAT_ROLES = ['customer', 'merchant', 'washer', 'courier', 'staff'];

@Resolver(() => Conversation)
@UseGuards(GqlAuthGuard, RolesGuard)
export class ChatResolver {
  constructor(private readonly chat: ChatService) {}

  @Roles(...CHAT_ROLES)
  @Query(() => [Conversation], { name: 'myConversations' })
  async myConversations(
    @CurrentUser() user: User,
    @ActiveBranch() activeBranchId: string | null,
  ): Promise<Conversation[]> {
    return this.chat.myConversations(user, activeBranchId);
  }

  @Roles(...CHAT_ROLES)
  @Query(() => [Message], { name: 'conversationMessages' })
  async conversationMessages(
    @Args('conversationId', { type: () => ID }) conversationId: string,
    @CurrentUser() user: User,
    @ActiveBranch() activeBranchId: string | null,
  ): Promise<Message[]> {
    return this.chat.messages(conversationId, user, activeBranchId);
  }

  @Roles(...CHAT_ROLES)
  @Mutation(() => Message, { name: 'sendMessage' })
  async sendMessage(
    @Args('input') input: SendMessageInput,
    @CurrentUser() user: User,
    @ActiveBranch() activeBranchId: string | null,
  ): Promise<Message> {
    return this.chat.sendMessage(user, input, activeBranchId);
  }

  // Upload-first, reference-next: the client uploads the image here, gets
  // back the storage key, then calls sendMessage with imageKey set. Mirrors
  // uploadHandoverProof's flow in online-orders.
  @Roles(...CHAT_ROLES)
  @Mutation(() => String, { name: 'uploadChatImage' })
  async uploadChatImage(
    @Args('conversationId', { type: () => ID }) conversationId: string,
    @Args('base64') base64: string,
    @Args('mimeType') mimeType: string,
    @CurrentUser() user: User,
    @ActiveBranch() activeBranchId: string | null,
  ): Promise<string> {
    return this.chat.uploadChatImage(
      user,
      conversationId,
      base64,
      mimeType,
      activeBranchId,
    );
  }

  // Oversight, not participation: admin/support are never customerUid or
  // providerUid on any thread, so this is a separate service path
  // (adminListConversations/adminMessages) rather than reusing
  // myConversations/conversationMessages's participant-scoped queries.
  @Roles('admin', 'support')
  @Query(() => PaginatedConversations, { name: 'adminConversations' })
  async adminConversations(
    @Args('input', { nullable: true }) input?: AdminConversationsInput,
  ): Promise<PaginatedConversations> {
    return this.chat.adminListConversations(input);
  }

  @Roles('admin', 'support')
  @Query(() => [Message], { name: 'adminConversationMessages' })
  async adminConversationMessages(
    @Args('conversationId', { type: () => ID }) conversationId: string,
  ): Promise<Message[]> {
    return this.chat.adminMessages(conversationId);
  }

  // Support holds this too. The message this posts renders under its own
  // "Support" sender label — never folded into customer/merchant/washer/
  // courier — and answering a customer in the thread they are already in is
  // the same job support does in a ticket, with a shorter path to the person
  // waiting. It stays a separate service path from myConversations because
  // admin/support are never a participant on the thread.
  @Roles('admin', 'support')
  @Mutation(() => Message, { name: 'adminSendMessage' })
  async adminSendMessage(
    @Args('conversationId', { type: () => ID }) conversationId: string,
    @Args('text') text: string,
    @CurrentUser() actor: User,
  ): Promise<Message> {
    return this.chat.adminSendMessage(actor, conversationId, text);
  }

  @Roles('customer')
  @Mutation(() => Conversation, { name: 'startConversation' })
  async startConversation(
    @Args('input') input: StartConversationInput,
    @CurrentUser() user: User,
  ): Promise<Conversation> {
    return this.chat.startConversation(user, input);
  }

  // Customer OR the rider currently working the leg — the service enforces
  // which, since the rider's permission depends on live order state, not role.
  @Mutation(() => Conversation, { name: 'startCourierConversation' })
  async startCourierConversation(
    @Args('input') input: StartCourierConversationInput,
    @CurrentUser() user: User,
  ): Promise<Conversation> {
    return this.chat.startCourierConversation(user, input);
  }

  // Whether this thread is closed to new messages for the caller.
  //
  // Resolved per viewer rather than stored: a courier thread ends for the RIDER
  // when their leg is handed over but never for the customer; a provider thread
  // ends for both sides once its order concludes.
  @ResolveField(() => Boolean, { name: 'ended' })
  async ended(
    @Parent() convo: Conversation,
    @CurrentUser() user: User,
  ): Promise<boolean> {
    return this.chat.isThreadEnded(convo, user);
  }

  // The Verified badge for the thread header. Resolved live rather than
  // stored, so it always agrees with the provider's profile — see
  // ChatService.isProviderVerified. False on courier threads.
  @ResolveField(() => Boolean, { name: 'providerVerified' })
  async providerVerified(@Parent() convo: Conversation): Promise<boolean> {
    return this.chat.isProviderVerified(convo);
  }
}

// Message field resolvers live in a separate @Resolver class: NestJS scopes
// @ResolveField to the type named in its class's @Resolver() decorator, so a
// Message field can't hang off ChatResolver (scoped to Conversation) above.
@Resolver(() => Message)
@UseGuards(GqlAuthGuard, RolesGuard)
export class ChatMessageResolver {
  constructor(private readonly chat: ChatService) {}

  // Signed, short-lived URL for an attached image — null when the message has
  // no image, or the viewer isn't a participant of its thread (resolved via
  // ChatService.resolveMessageImageUrl, which returns null rather than
  // throwing so a field failure never 500s an entire message-list query).
  @Roles(...CHAT_ROLES)
  @ResolveField(() => String, { name: 'imageUrl', nullable: true })
  async imageUrl(
    @Parent() message: Message,
    @CurrentUser() user: User,
  ): Promise<string | null> {
    return this.chat.resolveMessageImageUrl(message, user);
  }
}
