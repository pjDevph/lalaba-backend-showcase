import { Module, Global } from '@nestjs/common';
import { FirebaseService } from './firebase.service';

@Global()
@Module({
  providers: [FirebaseService],
  exports: [FirebaseService], // Exports the service so its helpers can be read everywhere
})
export class FirebaseModule {}
